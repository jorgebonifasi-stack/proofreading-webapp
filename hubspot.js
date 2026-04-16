/**
 * HubSpot API integration
 * Fetches deal details, notes, and document attachments
 */

const https = require("https");
const http = require("http");

const BASE_URL = "https://api.hubapi.com";

function apiGet(endpoint, token, params = {}) {
  return new Promise((resolve, reject) => {
    let url = `${BASE_URL}${endpoint}`;
    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    if (query) url += `?${query}`;

    const req = https.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HubSpot API ${res.statusCode}: ${data}`));
        } else {
          resolve(JSON.parse(data));
        }
      });
    });
    req.on("error", reject);
  });
}

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Extract deal ID from HubSpot URL
 */
function extractDealId(url) {
  const match = url.match(/record\/0-3\/(\d+)/);
  if (!match) throw new Error("Could not extract deal ID from HubSpot URL");
  return match[1];
}

/**
 * Fetch deal details
 */
async function getDeal(dealId, token) {
  return apiGet(`/crm/v3/objects/deals/${dealId}`, token, {
    properties: "dealname,dealstage,pipeline,amount,closedate,hubspot_owner_id",
  });
}

/**
 * Fetch notes associated with a deal
 */
async function getDealNotes(dealId, token) {
  let assoc;
  try {
    assoc = await apiGet(`/crm/v3/objects/deals/${dealId}/associations/notes`, token);
  } catch {
    return getDealEngagements(dealId, token);
  }

  const notes = [];
  if (assoc.results) {
    for (const result of assoc.results) {
      const noteId = result.id || result.toObjectId;
      if (noteId) {
        try {
          const note = await apiGet(`/crm/v3/objects/notes/${noteId}`, token, {
            properties: "hs_note_body,hs_attachment_ids,hs_timestamp",
          });
          notes.push(note);
        } catch (e) {
          console.warn(`Could not fetch note ${noteId}:`, e.message);
        }
      }
    }
  }
  return notes;
}

/**
 * Fallback: fetch engagements
 */
async function getDealEngagements(dealId, token) {
  try {
    const data = await apiGet(
      `/engagements/v1/engagements/associated/deal/${dealId}/paged`,
      token,
      { limit: "100" }
    );
    return data.results || [];
  } catch {
    return [];
  }
}

/**
 * Get file details from HubSpot
 */
async function getFileDetails(fileId, token) {
  return apiGet(`/files/v3/files/${fileId}`, token);
}

/**
 * Get signed download URL
 */
async function getSignedUrl(fileId, token) {
  return apiGet(`/files/v3/files/${fileId}/signed-url`, token);
}

/**
 * Extract attachment IDs from notes
 */
function extractAttachmentIds(notes) {
  const attachments = [];
  for (const note of notes) {
    if (note.properties) {
      const body = note.properties.hs_note_body || "";
      const attIds = note.properties.hs_attachment_ids || "";
      if (attIds) {
        for (const aid of String(attIds).split(";")) {
          const id = aid.trim();
          if (id) attachments.push({ id, sourceNote: body.substring(0, 100) });
        }
      }
    } else if (note.engagement) {
      for (const att of note.attachments || []) {
        if (att.id) {
          attachments.push({
            id: String(att.id),
            sourceNote: (note.engagement.bodyPreview || "").substring(0, 100),
          });
        }
      }
    }
  }
  return attachments;
}

/**
 * Main: fetch all documents from a HubSpot deal
 * Returns array of { filename, buffer, extension }
 */
async function fetchDealDocuments(dealId, token, onProgress) {
  onProgress?.("Fetching deal details...");
  const deal = await getDeal(dealId, token);
  const dealName = deal.properties?.dealname || "Unknown";
  onProgress?.(`Deal: ${dealName}`);

  onProgress?.("Fetching associated notes...");
  const notes = await getDealNotes(dealId, token);
  onProgress?.(`Found ${notes.length} notes/engagements`);

  const attachments = extractAttachmentIds(notes);
  onProgress?.(`Found ${attachments.length} file attachments`);

  const documents = [];
  for (const att of attachments) {
    try {
      const fileInfo = await getFileDetails(att.id, token);
      const filename = fileInfo.name || `file_${att.id}`;
      const ext = (fileInfo.extension || "").toLowerCase();

      if (!["pdf", "docx", "doc"].includes(ext)) {
        onProgress?.(`Skipping ${filename} (type: ${ext})`);
        continue;
      }

      let downloadUrl;
      try {
        const signed = await getSignedUrl(att.id, token);
        downloadUrl = signed.url;
      } catch {
        downloadUrl = fileInfo.url;
      }

      if (!downloadUrl) {
        onProgress?.(`No download URL for ${filename}`);
        continue;
      }

      onProgress?.(`Downloading ${filename}...`);
      const buffer = await downloadFile(downloadUrl);
      documents.push({ filename, buffer, extension: ext });
      onProgress?.(`Downloaded ${filename} (${(buffer.length / 1024).toFixed(0)}KB)`);
    } catch (e) {
      onProgress?.(`Error with file ${att.id}: ${e.message}`);
    }
  }

  return { dealName, documents };
}

module.exports = {
  extractDealId,
  fetchDealDocuments,
};

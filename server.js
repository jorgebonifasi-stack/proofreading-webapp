/**
 * Octopus Legacy Proofreading Tool — Server
 *
 * Express server that orchestrates:
 * 1. Inkwell scraping (consultation data, IF, IDs)
 * 2. HubSpot document fetching
 * 3. PDF text extraction & classification
 * 4. Checklist evaluation
 * 5. DOCX report generation
 */

require("dotenv").config();
const express = require("express");
const path = require("path");

const { extractDealId, fetchDealDocuments } = require("./hubspot");
const { extractConsultationId, scrapeInkwell, parseConsultationData } = require("./inkwell");
const { extractText, extractTextOCR, classifyDocument, parseWillData, parseLPAData, parseSEVData, parseInstructionForm } = require("./pdf-extract");
const { runWillChecklist, runLPAChecklist, runSEVChecklist, determineOutcome } = require("./checklist");
const { generateReport } = require("./report");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));
// Serve index.html and static files from the same directory (flat layout)
app.use(express.static(__dirname));

// Store active jobs and results
const jobs = new Map();

/**
 * POST /api/proofread
 * Start a proofreading job
 * Body: { hubspotUrl, inkwellUrl?, ifData? }
 * - ifData (optional): Pre-scraped instruction form data from Inkwell (via Cowork skill).
 *   When provided, server-side Inkwell scraping is skipped entirely.
 * - inkwellUrl is optional when ifData is provided.
 */
app.post("/api/proofread", (req, res) => {
  const { hubspotUrl, inkwellUrl, ifData } = req.body;

  if (!hubspotUrl) {
    return res.status(400).json({ error: "HubSpot URL is required" });
  }

  if (!inkwellUrl && !ifData) {
    return res.status(400).json({ error: "Either an Inkwell URL or IF data must be provided" });
  }

  let dealId;
  try {
    dealId = extractDealId(hubspotUrl);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  let consultationId = null;
  if (inkwellUrl) {
    try {
      consultationId = extractConsultationId(inkwellUrl);
    } catch (e) {
      // Not fatal if ifData is provided
      if (!ifData) return res.status(400).json({ error: e.message });
    }
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  jobs.set(jobId, {
    status: "running",
    progress: [],
    result: null,
    error: null,
    startedAt: new Date().toISOString(),
  });

  // Run the job asynchronously, passing ifData if provided
  runProofreadJob(jobId, dealId, inkwellUrl, ifData || null).catch((err) => {
    const job = jobs.get(jobId);
    if (job) {
      job.status = "error";
      job.error = err.message;
    }
  });

  res.json({ jobId, dealId, consultationId });
});

/**
 * GET /api/proofread/:jobId/status
 * Get job status and progress (SSE stream)
 */
app.get("/api/proofread/:jobId/status", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let lastSent = 0;
  const interval = setInterval(() => {
    const j = jobs.get(req.params.jobId);
    if (!j) {
      clearInterval(interval);
      res.end();
      return;
    }

    // Send new progress messages
    while (lastSent < j.progress.length) {
      res.write(`data: ${JSON.stringify({ type: "progress", message: j.progress[lastSent] })}\n\n`);
      lastSent++;
    }

    if (j.status === "complete") {
      res.write(`data: ${JSON.stringify({ type: "complete", result: j.result })}\n\n`);
      clearInterval(interval);
      res.end();
    } else if (j.status === "error") {
      res.write(`data: ${JSON.stringify({ type: "error", error: j.error })}\n\n`);
      clearInterval(interval);
      res.end();
    }
  }, 500);

  req.on("close", () => clearInterval(interval));
});

/**
 * GET /api/proofread/:jobId/debug-if
 * View the raw extracted IF text (for debugging parser)
 */
app.get("/api/proofread/:jobId/debug-if", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.setHeader("Content-Type", "text/plain");
  res.send(job.debugIfText || "No IF text captured");
});

/**
 * POST /api/test-ocr
 * Start a standalone OCR test job: fetches the IF from a HubSpot deal, runs OCR,
 * stores raw text + parsed data. Progress streamed via SSE at /api/test-ocr/:jobId/status.
 * Body: { hubspotUrl }
 */
app.post("/api/test-ocr", (req, res) => {
  const { hubspotUrl } = req.body;
  if (!hubspotUrl) return res.status(400).json({ error: "hubspotUrl is required" });

  let dealId;
  try {
    dealId = extractDealId(hubspotUrl);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const jobId = `ocr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  jobs.set(jobId, {
    status: "running",
    progress: [],
    result: null,
    error: null,
    startedAt: new Date().toISOString(),
  });

  // Run OCR asynchronously
  runOCRTestJob(jobId, dealId).catch((err) => {
    const job = jobs.get(jobId);
    if (job) { job.status = "error"; job.error = err.message; }
  });

  res.json({ jobId });
});

/**
 * GET /api/test-ocr/:jobId/status
 * SSE stream for OCR test job progress
 */
app.get("/api/test-ocr/:jobId/status", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let lastSent = 0;
  const interval = setInterval(() => {
    const j = jobs.get(req.params.jobId);
    if (!j) { clearInterval(interval); res.end(); return; }

    while (lastSent < j.progress.length) {
      res.write(`data: ${JSON.stringify({ type: "progress", message: j.progress[lastSent] })}\n\n`);
      lastSent++;
    }

    if (j.status === "complete") {
      res.write(`data: ${JSON.stringify({ type: "complete", result: j.result })}\n\n`);
      clearInterval(interval);
      res.end();
    } else if (j.status === "error") {
      res.write(`data: ${JSON.stringify({ type: "error", error: j.error })}\n\n`);
      clearInterval(interval);
      res.end();
    }
  }, 500);

  req.on("close", () => clearInterval(interval));
});

/**
 * OCR test job runner
 */
async function runOCRTestJob(jobId, dealId) {
  const job = jobs.get(jobId);
  const token = process.env.HUBSPOT_API_TOKEN;
  const progress = (msg) => { job.progress.push(msg); console.log(`[${jobId}] ${msg}`); };

  try {
    progress("OCR test started — Deal ID: " + dealId);

    // Pre-flight check: is pdftoppm available?
    try {
      require("child_process").execSync("which pdftoppm");
      progress("pdftoppm found ✓");
    } catch (_) {
      throw new Error("pdftoppm not found — the Dockerfile needs poppler-utils. Did you upload the updated Dockerfile?");
    }

    progress("Fetching documents from HubSpot...");
    const { dealName, documents } = await fetchDealDocuments(dealId, token, progress);

    // Find the IF document
    let ifDocument = null;
    for (const doc of documents) {
      const fname = doc.filename.toLowerCase();
      if (fname === "if" || fname === "if.pdf" || fname.startsWith("if.") || fname.startsWith("if-") ||
          (fname.includes("instruction") && fname.includes("form"))) {
        ifDocument = doc;
        break;
      }
    }

    if (!ifDocument) {
      throw new Error("No IF document found in deal. Files found: " + documents.map(d => d.filename).join(", "));
    }

    progress(`Found IF: ${ifDocument.filename} (${Math.round(ifDocument.buffer.length / 1024)}KB)`);

    // Run OCR
    progress("Starting OCR (this may take 1-3 minutes for a full IF)...");
    const ocrResult = await extractTextOCR(ifDocument.buffer, progress);

    // Run the parser on OCR text
    progress("Parsing OCR text into structured data...");
    const parsed = parseInstructionForm(ocrResult.text);

    progress("Done! Parsed fields: " + Object.entries(parsed)
      .filter(([, v]) => v && (typeof v === "string" ? v.length > 0 : Array.isArray(v) ? v.length > 0 : true))
      .map(([k]) => k).join(", "));

    job.result = {
      dealName,
      ifFilename: ifDocument.filename,
      ocrPages: ocrResult.numPages,
      ocrChars: ocrResult.text.length,
      ocrText: ocrResult.text,
      parsedData: parsed,
    };
    job.status = "complete";
  } catch (e) {
    progress(`ERROR: ${e.message}`);
    job.status = "error";
    job.error = e.message;
    throw e;
  }
}

/**
 * GET /api/proofread/:jobId/report
 * Download the DOCX report
 */
app.get("/api/proofread/:jobId/report", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "complete" || !job.result) {
    return res.status(404).json({ error: "Report not ready" });
  }

  try {
    const buffer = await generateReport(job.result);
    const ref = job.result.consultation.reference || "report";
    const date = new Date().toISOString().split("T")[0];
    const filename = `Proofreading-Report-${ref}-${date}.docx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: `Report generation failed: ${e.message}` });
  }
});

/**
 * Main proofreading job runner
 * @param {string} jobId
 * @param {string} dealId
 * @param {string|null} inkwellUrl
 * @param {object|null} externalIfData - Pre-scraped IF data from Cowork skill (skips Inkwell scraping)
 */
async function runProofreadJob(jobId, dealId, inkwellUrl, externalIfData) {
  const job = jobs.get(jobId);
  const token = process.env.HUBSPOT_API_TOKEN;

  const progress = (msg) => {
    job.progress.push(msg);
    console.log(`[${jobId}] ${msg}`);
  };

  try {
    // Step 1: Fetch documents from HubSpot
    progress("Step 1/5: Fetching documents from HubSpot...");
    const { dealName, documents } = await fetchDealDocuments(dealId, token, progress);

    if (documents.length === 0) {
      throw new Error("No PDF documents found in the HubSpot deal");
    }

    // Separate instruction form (IF) from drafted documents (Will, LPA, SEV)
    let ifDocument = null;
    const draftedDocs = [];
    for (const doc of documents) {
      const fname = doc.filename.toLowerCase();
      if (fname === "if" || fname === "if.pdf" || fname.startsWith("if.") || fname.startsWith("if-") ||
          (fname.includes("instruction") && fname.includes("form"))) {
        ifDocument = doc; // Keep the IF for parsing
      } else {
        draftedDocs.push(doc);
      }
    }
    if (ifDocument) {
      progress(`Found instruction form: ${ifDocument.filename} (${Math.round(ifDocument.buffer.length / 1024)}KB)`);
    }

    // Group documents by type, sorted newest-first per group
    // Arken filenames: Name-TYPE-VERSION-ENGROSSMENT-DD-MM-YYYY HH-MM-SS
    const docGroups = new Map();
    for (const doc of draftedDocs) {
      const typeMatch = doc.filename.match(/^(.+?-(?:WILL|LPAHW|LPAPA|LPAPFA|SEV))/i);
      const key = typeMatch ? typeMatch[1].toUpperCase() : doc.filename;
      const dateMatch = doc.filename.match(/(\d{2})-(\d{2})-(\d{4})\s+(\d{2})-(\d{2})-(\d{2})/);
      const timestamp = dateMatch
        ? new Date(dateMatch[3], dateMatch[2]-1, dateMatch[1], dateMatch[4], dateMatch[5], dateMatch[6]).getTime()
        : 0;
      if (!docGroups.has(key)) docGroups.set(key, []);
      docGroups.get(key).push({ doc, timestamp });
    }
    // Sort each group newest-first
    for (const [, versions] of docGroups) {
      versions.sort((a, b) => b.timestamp - a.timestamp);
    }

    progress(`Found ${docGroups.size} document type(s) across ${draftedDocs.length} file(s) (${documents.length - draftedDocs.length} non-drafts excluded)`);

    // Step 2: Get instruction form data
    let ifData;
    if (externalIfData && typeof externalIfData === "object" && externalIfData.clientName) {
      // IF data provided externally (scraped by Cowork skill via Chrome)
      progress("Step 2/5: Using pre-scraped IF data from Cowork...");
      ifData = Object.assign(buildIFData(null, dealName), externalIfData);
      progress(`Client: ${ifData.clientName} (from Cowork IF data)`);
    } else if (ifDocument) {
      // Parse the IF.pdf downloaded from HubSpot using OCR (scanned/handwritten form)
      progress("Step 2/5: Parsing instruction form (IF.pdf) via OCR...");
      try {
        // First try OCR (for scanned/handwritten forms)
        const ocrResult = await extractTextOCR(ifDocument.buffer, progress);
        progress(`  OCR extracted: ${ocrResult.numPages} pages, ${ocrResult.text.length} chars`);
        // Store raw OCR text for debugging
        job.debugIfText = ocrResult.text;

        // Also get the pdf-parse text layer (has some printed labels that help with parsing)
        let pdfParseText = "";
        try {
          const pdfResult = await extractText(ifDocument.buffer);
          pdfParseText = pdfResult.text;
        } catch (_) { /* ignore - OCR text is primary */ }

        // Use OCR text as primary source, fall back to pdf-parse text for any missed fields
        const parsedIF = parseInstructionForm(ocrResult.text);
        const parsedFallback = pdfParseText ? parseInstructionForm(pdfParseText) : {};

        // Merge: OCR takes priority, pdf-parse fills gaps
        const merged = { ...parsedFallback, ...parsedIF };
        // For arrays, prefer whichever has more entries
        for (const key of ["executors", "attorneys", "guardians", "replacementAttorneys",
                           "peopleToNotify", "specificGifts", "cashGifts", "charities",
                           "residue", "propertyGifts", "exclusions"]) {
          const ocrArr = parsedIF[key] || [];
          const fallArr = parsedFallback[key] || [];
          merged[key] = ocrArr.length >= fallArr.length ? ocrArr : fallArr;
        }

        ifData = Object.assign(buildIFData(null, dealName), merged);
        if (!ifData.clientName || ifData.clientName.length < 3) {
          ifData.clientName = buildIFData(null, dealName).clientName;
        }
        progress(`Client: ${ifData.clientName} (from IF.pdf OCR)`);
        if (ifData.reference) progress(`  Reference: ${ifData.reference}`);
        if (ifData.dob) progress(`  DOB: ${ifData.dob}`);
        if (ifData.address) progress(`  Address: ${ifData.address}`);
        if (ifData.maritalStatus) progress(`  Marital status: ${ifData.maritalStatus}`);
        if (ifData.executors?.length) progress(`  Executors: ${ifData.executors.map(e => e.name || e).join(", ")}`);
        if (ifData.attorneys?.length) progress(`  Attorneys: ${ifData.attorneys.map(a => a.name || a).join(", ")}`);
        if (ifData.certificateProvider) progress(`  Certificate Provider: ${ifData.certificateProvider.name || ifData.certificateProvider}`);
        if (ifData.funeralWishes) progress(`  Funeral wishes: ${ifData.funeralWishes}`);
      } catch (ifErr) {
        progress(`  IF OCR/parsing failed: ${ifErr.message} — falling back to deal name`);
        ifData = buildIFData(null, dealName);
      }
    } else {
      // No IF document and no external data — try Inkwell scraping as last resort
      progress("Step 2/5: No IF.pdf found — trying Inkwell scraping...");
      let inkwellData = null;
      if (inkwellUrl) {
        try {
          inkwellData = await scrapeInkwell(inkwellUrl, progress);
        } catch (e) {
          progress(`Inkwell scraping failed (${e.message}) — using deal name only`);
        }
      }
      ifData = buildIFData(inkwellData, dealName);
      progress(`Client: ${ifData.clientName || dealName}`);
    }

    // Step 3: Extract and classify documents
    // For each doc type, try newest version first; if unreadable (e.g. password-protected), fall back to older versions
    progress("Step 3/5: Extracting text from documents...");
    const processedDocs = [];
    for (const [typeKey, versions] of docGroups) {
      let success = false;
      for (const { doc, timestamp } of versions) {
        progress(`Processing ${doc.filename}...`);
        let extracted;
        try {
          extracted = await extractText(doc.buffer);
        } catch (pdfErr) {
          progress(`  Cannot read ${doc.filename}: ${pdfErr.message} (may be password-protected)`);
          if (versions.length > 1) {
            progress(`  Trying an older version...`);
          }
          continue;
        }
        const docType = classifyDocument(extracted.text, doc.filename);
        progress(`  Classified as: ${docType} (${extracted.numPages} pages)`);

        let parsedData;
        switch (docType) {
          case "Will":
            parsedData = parseWillData(extracted.text);
            break;
          case "LPA_HW":
            parsedData = parseLPAData(extracted.text, "LPA_HW");
            break;
          case "LPA_PFA":
            parsedData = parseLPAData(extracted.text, "LPA_PFA");
            break;
          case "SEV":
            parsedData = parseSEVData(extracted.text);
            break;
          default:
            parsedData = { rawText: extracted.text };
        }

        processedDocs.push({
          filename: doc.filename,
          type: docType,
          text: extracted.text,
          numPages: extracted.numPages,
          parsedData,
        });
        success = true;
        break; // Got a readable version for this type, move on
      }
      if (!success) {
        progress(`  WARNING: All versions of ${typeKey} are unreadable — skipping entirely`);
      }
    }

    // Step 4: Run checklists
    progress("Step 4/5: Running proofreading checklists...");
    const docResults = [];
    for (const doc of processedDocs) {
      progress(`  Checking ${doc.type}: ${doc.filename}...`);
      let sections;
      switch (doc.type) {
        case "Will":
          sections = runWillChecklist(doc.parsedData, ifData);
          break;
        case "LPA_HW":
        case "LPA_PFA":
          sections = runLPAChecklist(doc.parsedData, ifData);
          break;
        case "SEV":
          sections = runSEVChecklist(doc.parsedData, ifData);
          break;
        default:
          sections = [
            {
              title: "Unknown Document Type",
              checks: [
                {
                  id: "U.1",
                  item: "Document type could not be classified",
                  status: "FLAG",
                  notes: "Manual review required for unrecognised document",
                },
              ],
            },
          ];
      }

      const outcome = determineOutcome(sections);
      const typeName = {
        Will: "Will",
        LPA_HW: "LPA (Health & Welfare)",
        LPA_PFA: "LPA (Property & Financial Affairs)",
        SEV: "Severance of Joint Tenancy",
      }[doc.type] || doc.type;

      // Count results
      let passes = 0, fails = 0, flags = 0, nas = 0;
      for (const s of sections) {
        for (const c of s.checks) {
          if (c.status === "PASS") passes++;
          else if (c.status === "FAIL") fails++;
          else if (c.status === "FLAG") flags++;
          else nas++;
        }
      }
      progress(`  Result: ${outcome} (${passes} PASS, ${fails} FAIL, ${flags} FLAG, ${nas} N/A)`);

      docResults.push({
        name: `${typeName} of ${ifData.clientName || "Client"}`,
        type: typeName,
        filename: doc.filename,
        outcome,
        sections,
        stats: { passes, fails, flags, nas },
      });
    }

    // Step 5: Build final result
    progress("Step 5/5: Compiling results...");

    const allSections = docResults.flatMap((d) => d.sections);
    const overallOutcome = determineOutcome(allSections);

    // Build recommended actions from FAILs and significant FLAGs
    const recommendedActions = [];
    for (const doc of docResults) {
      for (const section of doc.sections) {
        for (const check of section.checks) {
          if (check.status === "FAIL") {
            recommendedActions.push({
              document: doc.name,
              action: `${check.item}: ${check.notes}`,
              hubspotNote: check.notes,
            });
          }
        }
      }
    }

    // Build summary
    const totalChecks = allSections.reduce((sum, s) => sum + s.checks.length, 0);
    const totalFails = docResults.reduce((sum, d) => sum + d.stats.fails, 0);
    const totalFlags = docResults.reduce((sum, d) => sum + d.stats.flags, 0);
    const totalPasses = docResults.reduce((sum, d) => sum + d.stats.passes, 0);

    const summary = `${docResults.length} document(s) reviewed for ${ifData.clientName || dealName}. ` +
      `${totalChecks} checks performed: ${totalPasses} PASS, ${totalFails} FAIL, ${totalFlags} FLAG. ` +
      (totalFails > 0
        ? `${totalFails} item(s) require correction before approval.`
        : totalFlags > 0
        ? `${totalFlags} item(s) flagged for human review.`
        : "All checks passed.");

    const result = {
      consultation: {
        reference: ifData.reference || "N/A",
        clientNames: [ifData.clientName || dealName],
        address: ifData.address || "",
        consultationType: ifData.consultationType || "single",
        reviewDate: new Date().toISOString().split("T")[0],
        reviewer: "Proofreading Tool (Automated)",
      },
      documents: docResults,
      overallOutcome,
      summary,
      recommendedActions,
    };

    job.result = result;
    job.status = "complete";
    progress(`Complete! Overall outcome: ${overallOutcome}`);
  } catch (e) {
    progress(`ERROR: ${e.message}`);
    job.status = "error";
    job.error = e.message;
    throw e;
  }
}

/**
 * Build IF data structure from Inkwell scraped data
 */
function buildIFData(inkwellData, dealName) {
  const data = {
    clientName: "",
    reference: "",
    address: "",
    postcode: "",
    dob: "",
    maritalStatus: "",
    consultationType: "single",
    funeralWishes: "",
    executors: [],
    executorType: "",
    attorneys: [],
    decisionType: "",
    certificateProvider: null,
    replacementAttorneys: [],
    peopleToNotify: [],
    guardians: [],
    specificGifts: [],
    cashGifts: [],
    charities: [],
    residue: [],
    trustType: "",
    propertyGifts: [],
    exclusions: [],
    upcomingMarriage: false,
    accessibilityNeeds: false,
    minorBeneficiaries: false,
    idVerifiedName: "",
  };

  if (!inkwellData) {
    // Fallback: parse client name from deal name
    // Deal names are like "Claire Witton on behalf of Keith Lovesy - WSL Website"
    let name = dealName;
    // If "on behalf of" exists, the actual client is AFTER it
    const onBehalfMatch = name.match(/on\s+behalf\s+of\s+(.+?)(?:\s*-|$)/i);
    if (onBehalfMatch) {
      name = onBehalfMatch[1].trim();
    } else {
      name = name.replace(/\s*-\s*.*/g, "").trim();
    }
    data.clientName = name;
    return data;
  }

  // Parse from Inkwell page text
  const parsed = parseConsultationData(inkwellData.pageText);
  Object.assign(data, parsed);

  return data;
}

// Start server
app.listen(PORT, () => {
  console.log(`\n  Octopus Legacy Proofreading Tool`);
  console.log(`  Running at http://localhost:${PORT}\n`);
});

/**
 * Inkwell consultation data scraper
 * Uses Puppeteer to extract consultation details and ID documents
 */

let puppeteer;
try {
  puppeteer = require("puppeteer");
} catch {
  console.warn("Puppeteer not available — Inkwell scraping will use fallback mode");
}

/**
 * Extract consultation ID from Inkwell URL
 */
function extractConsultationId(url) {
  const match = url.match(
    /consultations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  if (!match) throw new Error("Could not extract consultation ID from Inkwell URL");
  return match[1];
}

/**
 * Scrape consultation data from Inkwell using Puppeteer
 */
async function scrapeInkwell(consultationUrl, onProgress) {
  if (!puppeteer) {
    throw new Error("Puppeteer not installed — cannot scrape Inkwell");
  }

  onProgress?.("Launching browser for Inkwell...");

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Navigate to Inkwell consultation
    onProgress?.("Navigating to Inkwell consultation...");
    await page.goto(consultationUrl, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for page to load
    await page.waitForTimeout(3000);

    // Extract consultation data from the page
    onProgress?.("Extracting consultation data...");
    const consultationData = await page.evaluate(() => {
      const getText = (selector) => {
        const el = document.querySelector(selector);
        return el ? el.textContent.trim() : "";
      };

      const getAllText = () => document.body.innerText;
      return { pageText: getAllText() };
    });

    // Try to navigate to integrations tab for IF data
    onProgress?.("Looking for instruction form data...");
    try {
      const integrationsTab = await page.$('button:has-text("Integrations"), a:has-text("Integrations"), [role="tab"]:has-text("Integrations")');
      if (integrationsTab) {
        await integrationsTab.click();
        await page.waitForTimeout(2000);
      }
    } catch {
      onProgress?.("Could not find Integrations tab — continuing with main page data");
    }

    // Extract any PDF links (instruction forms, IDs)
    const links = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      return anchors
        .filter((a) => {
          const href = a.href.toLowerCase();
          return href.includes("pdf") || href.includes("supabase") || href.includes("attachment");
        })
        .map((a) => ({ href: a.href, text: a.textContent.trim() }));
    });

    // Extract image sources (ID documents)
    const images = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img[src]"));
      return imgs
        .filter((img) => {
          const src = img.src.toLowerCase();
          return (
            src.includes("supabase") ||
            src.includes("proof") ||
            src.includes("id") ||
            src.includes("licence") ||
            src.includes("passport")
          );
        })
        .map((img) => ({ src: img.src, alt: img.alt || "" }));
    });

    onProgress?.(`Found ${links.length} document links and ${images.length} ID images`);

    return {
      pageText: consultationData.pageText,
      documentLinks: links,
      idImages: images,
      url: consultationUrl,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Parse consultation details from page text
 */
function parseConsultationData(pageText) {
  const data = {
    clientName: "",
    reference: "",
    address: "",
    postcode: "",
    consultationType: "single",
    dob: "",
    maritalStatus: "",
    children: [],
    executors: [],
    attorneys: [],
    certificateProvider: null,
    funeralWishes: "",
    specificGifts: [],
    residue: [],
    trusts: [],
  };

  // Extract OL reference
  const refMatch = pageText.match(/OL-[\dA-Z]{3}-[\dA-Z]{3}/i);
  if (refMatch) data.reference = refMatch[0];

  // Extract name patterns
  const nameMatch = pageText.match(
    /(?:Mr|Mrs|Ms|Miss|Dr)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/
  );
  if (nameMatch) data.clientName = nameMatch[0];

  // Extract postcode
  const postcodeMatch = pageText.match(
    /[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i
  );
  if (postcodeMatch) data.postcode = postcodeMatch[0];

  // Detect consultation type
  if (
    pageText.toLowerCase().includes("pair") ||
    pageText.toLowerCase().includes("mirror")
  ) {
    data.consultationType = "pair";
  }

  return data;
}

module.exports = {
  extractConsultationId,
  scrapeInkwell,
  parseConsultationData,
};

/**
 * PDF text extraction and document classification
 */

const pdfParse = require("pdf-parse");
const { createWorker } = require("tesseract.js");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Extract text from a PDF buffer
 */
async function extractText(buffer) {
  const data = await pdfParse(buffer);
  return {
    text: data.text,
    numPages: data.numpages,
    info: data.info,
  };
}

/**
 * Extract text from a scanned/handwritten PDF using OCR (tesseract.js).
 * Converts each page to a PNG via pdftoppm, then runs OCR on each image.
 * @param {Buffer} pdfBuffer - The PDF file as a buffer
 * @param {function} [onProgress] - Optional progress callback (message string)
 * @returns {Promise<{text: string, numPages: number, pageTexts: string[]}>}
 */
async function extractTextOCR(pdfBuffer, onProgress) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-"));
  const pdfPath = path.join(tmpDir, "input.pdf");
  const imgPrefix = path.join(tmpDir, "page");

  try {
    // Write PDF to temp file
    fs.writeFileSync(pdfPath, pdfBuffer);

    // Convert PDF pages to PNG images using pdftoppm (poppler-utils)
    // -r 300 = 300 DPI for good OCR quality on handwriting
    // -png = output PNG format
    if (onProgress) onProgress("  Converting IF pages to images (300 DPI)...");
    try {
      execSync(`pdftoppm -r 300 -png "${pdfPath}" "${imgPrefix}"`, {
        timeout: 120000, // 2 min max
        maxBuffer: 50 * 1024 * 1024, // 50MB stdout buffer
      });
    } catch (convErr) {
      throw new Error(`PDF-to-image conversion failed: ${convErr.message}`);
    }

    // Find all generated page images (pdftoppm names them page-01.png, page-02.png, etc.)
    const imageFiles = fs
      .readdirSync(tmpDir)
      .filter((f) => f.startsWith("page-") && f.endsWith(".png"))
      .sort();

    if (imageFiles.length === 0) {
      throw new Error("pdftoppm produced no page images");
    }

    if (onProgress) onProgress(`  ${imageFiles.length} page image(s) generated, starting OCR...`);

    // Create a single tesseract worker (reuse across pages for speed)
    const worker = await createWorker("eng");

    const pageTexts = [];
    for (let i = 0; i < imageFiles.length; i++) {
      const imgPath = path.join(tmpDir, imageFiles[i]);
      if (onProgress && (i % 5 === 0 || i === imageFiles.length - 1)) {
        onProgress(`  OCR page ${i + 1}/${imageFiles.length}...`);
      }
      const { data } = await worker.recognize(imgPath);
      pageTexts.push(data.text);
    }

    await worker.terminate();

    const fullText = pageTexts.join("\n--- PAGE BREAK ---\n");
    if (onProgress) onProgress(`  OCR complete: ${imageFiles.length} pages, ${fullText.length} chars`);

    return {
      text: fullText,
      numPages: imageFiles.length,
      pageTexts,
    };
  } finally {
    // Clean up temp files
    try {
      const files = fs.readdirSync(tmpDir);
      for (const f of files) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch (_) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Classify a document based on its text content
 * Returns: "Will", "LPA_HW", "LPA_PFA", "SEV", or "Unknown"
 */
function classifyDocument(text, filename = "") {
  const lower = text.toLowerCase();
  const fnameLower = filename.toLowerCase();

  // Check filename patterns first (Arken naming convention)
  if (fnameLower.includes("-will-")) return "Will";
  if (fnameLower.includes("-lpahw-")) return "LPA_HW";
  if (fnameLower.includes("-lpapa-") || fnameLower.includes("-lpapfa-")) return "LPA_PFA";
  if (fnameLower.includes("-sev-")) return "SEV";

  // Fallback to content analysis
  if (lower.includes("last will and testament") || lower.includes("will of")) {
    return "Will";
  }
  if (lower.includes("health and welfare") && lower.includes("lasting power of attorney")) {
    return "LPA_HW";
  }
  if (
    lower.includes("property and financial") &&
    lower.includes("lasting power of attorney")
  ) {
    return "LPA_PFA";
  }
  if (lower.includes("severance of joint tenancy") || lower.includes("notice of severance")) {
    return "SEV";
  }

  return "Unknown";
}

/**
 * Extract structured data from a Will document
 */
function parseWillData(text) {
  const data = {
    testatorName: "",
    address: "",
    executors: [],
    guardians: [],
    specificGifts: [],
    residueBeneficiaries: [],
    funeralWishes: "",
    hasSTEP3rdEdition: false,
    hasRevocationClause: false,
    hasEnglandWales: false,
    hasSection33Exclusion: false,
    hasNonProvisionClause: false,
    maritalStatus: "",
    rawText: text,
  };

  // Check for STEP edition
  if (text.match(/third\s+edition/i)) data.hasSTEP3rdEdition = true;
  if (text.match(/second\s+edition/i)) data.hasSTEP3rdEdition = false;

  // Check for standard clauses
  if (text.match(/revok/i)) data.hasRevocationClause = true;
  if (text.match(/england\s+and\s+wales/i)) data.hasEnglandWales = true;
  if (text.match(/section\s+33/i)) data.hasSection33Exclusion = true;
  if (text.match(/non[- ]provision|exclusion/i)) data.hasNonProvisionClause = true;

  // Funeral wishes
  if (text.match(/cremat/i)) data.funeralWishes = "cremation";
  else if (text.match(/burial|buried/i)) data.funeralWishes = "burial";

  // Marital status
  if (text.match(/widow/i)) data.maritalStatus = "widowed";
  else if (text.match(/my\s+(wife|husband|spouse|partner)/i)) {
    data.maritalStatus = "married/partnered";
  }

  // Check percentages add up (look for fraction/percentage patterns)
  const percentMatches = text.match(/(\d+)\s*(%|per\s*cent)/gi) || [];
  const fractionMatches = text.match(/equal\s+shares/i);
  if (fractionMatches) {
    data.residuePercentagesTotal = 100;
  } else if (percentMatches.length > 0) {
    const total = percentMatches.reduce((sum, m) => {
      const num = parseInt(m);
      return isNaN(num) ? sum : sum + num;
    }, 0);
    data.residuePercentagesTotal = total;
  }

  // Check for per stirpes / substitution of issue
  data.hasSOI = !!(
    text.match(/per\s+stirpes/i) || text.match(/substitution\s+of\s+issue/i)
  );

  // Check for trusts
  data.hasTrust =
    !!text.match(/discretionary\s+trust/i) ||
    !!text.match(/flexible\s+life\s+interest/i) ||
    !!text.match(/vulnerable\s+person/i);

  return data;
}

/**
 * Extract structured data from an LPA document
 */
function parseLPAData(text, type) {
  const data = {
    type: type, // "LPA_HW" or "LPA_PFA"
    donorName: "",
    donorDOB: "",
    donorAddress: "",
    attorneys: [],
    replacementAttorneys: [],
    decisionType: "", // "jointly", "jointly_and_severally", "jointly_for_some"
    certificateProvider: null,
    instructions: "",
    preferences: "",
    peopleToNotify: [],
    hasLifeSustainingTreatment: null, // H&W only
    whenCanAttorneysAct: null, // P&FA only: "registered" or "lack_capacity"
    formVersion: "",
    rawText: text,
  };

  // Form version
  const formMatch = text.match(/LP1[FH]\s+.*?\((\d{2}\.\d{2})\)/);
  if (formMatch) data.formVersion = formMatch[1];

  // Decision type
  if (text.match(/jointly\s+and\s+severally/i)) {
    data.decisionType = "jointly_and_severally";
  } else if (text.match(/jointly\b/i) && !text.match(/jointly\s+and/i)) {
    data.decisionType = "jointly";
  }

  return data;
}

/**
 * Extract structured data from a SEV document
 */
function parseSEVData(text) {
  return {
    jointTenants: [],
    propertyAddress: "",
    titleNumber: "",
    isFiftyFifty: !!text.match(/equal\s+shares|50\s*[/%]\s*/i),
    rawText: text,
  };
}

/**
 * Parse the Octopus Legacy "Estate planning consultation form" (IF.pdf)
 * from OCR'd text. The OCR output has:
 * - Section headers like "9 | EXECUTORS AND TRUSTEES"
 * - Field labels like "Name (First, Middle(s), Last)" followed by garbled handwriting
 * - "--- PAGE BREAK ---" markers between pages
 * - Handwritten names often have OCR artefacts: "Ke1t™ Lovesy", "CL RE ALLISON W(TTON"
 */
function parseInstructionForm(text) {
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

  // Clean up: normalise whitespace, split into lines
  const t = text.replace(/\r\n/g, "\n");
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);

  // Octopus Legacy's own postcode — must NOT be treated as client's
  const OL_POSTCODES = ["SE19HF", "SE1 9HF"];

  // ===== HELPER FUNCTIONS =====

  /**
   * Find the line index where a pattern appears
   */
  const findLineIndex = (pattern, startFrom = 0) => {
    const re = new RegExp(pattern, "i");
    for (let i = startFrom; i < lines.length; i++) {
      if (re.test(lines[i])) return i;
    }
    return -1;
  };

  /**
   * Grab "data lines" after a label — skips lines that look like more labels
   * and stops at page breaks or next section headers.
   * Returns the raw text found (may be garbled OCR handwriting).
   */
  const grabAfterLabel = (labelPattern, maxLines = 5, startFrom = 0) => {
    const idx = findLineIndex(labelPattern, startFrom);
    if (idx === -1) return { text: "", lineIndex: -1 };
    const collected = [];
    for (let j = idx + 1; j <= idx + maxLines && j < lines.length; j++) {
      const line = lines[j];
      if (!line || line === "--- PAGE BREAK ---") break;
      // Stop at section headers like "10 | GUARDIANSHIP"
      if (/^\d+\s*[|\]]/.test(line)) break;
      // Skip lines that are clearly just form labels (all lowercase common words)
      if (/^(If |Are |Do |Is |Please |Note |The |Has |Were |Other |Full address|Relationship|Postcode|Date of birth|Role)/i.test(line)) break;
      collected.push(line);
    }
    return { text: collected.join(" ").trim(), lineIndex: idx };
  };

  /**
   * Extract handwritten name from OCR text near a "Name (First..." label.
   * The handwritten name typically appears on the same line after the label
   * or on the next 1-2 lines. OCR garbles it but we grab whatever is there.
   */
  const grabNameAfterLabel = (startFrom = 0) => {
    // Look for name field labels — these patterns match the full label including "(First, Middle(s), Last)"
    const labelRegex = /Name\s*[\(\[]\s*First\s*,?\s*(?:Middle\(?s?\)?\s*,?\s*)?(?:Last)?\s*[\)\]]?/i;
    const labelRegex2 = /Name\s*\[\s*First\s*,?\s*Last\s*\]/i;

    let idx = -1;
    for (let i = startFrom; i < lines.length; i++) {
      if (labelRegex.test(lines[i]) || labelRegex2.test(lines[i])) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return { name: "", lineIndex: -1 };

    // Strip the entire label from the line to get just the handwritten name after it
    let sameLine = lines[idx]
      .replace(/Name\s*[\(\[]\s*First\s*,?\s*(?:Middle\(?s?\)?\s*,?\s*)?(?:Last)?\s*[\)\]]?\s*/i, "")
      .replace(/Name\s*\[\s*First\s*,?\s*Last\s*\]\s*/i, "")
      .replace(/[)\]]/g, "")
      .trim();

    // Also grab the next 1-2 lines as potential name data
    const nextLines = [];
    for (let j = idx + 1; j <= idx + 2 && j < lines.length; j++) {
      const line = lines[j];
      if (!line || line === "--- PAGE BREAK ---" || /^\d+\s*[|\]]/.test(line)) break;
      // Skip obvious non-name lines
      if (/^(Relationship|Full address|Postcode|Date of birth|Role |If |Are |Do |Customer|acting for|apply|or$|Signed)/i.test(line)) break;
      nextLines.push(line);
    }

    const rawName = (sameLine + " " + nextLines.join(" ")).trim();
    if (rawName.length > 1) {
      return { name: cleanOCRName(rawName), lineIndex: idx };
    }
    return { name: "", lineIndex: -1 };
  };

  /**
   * Clean up an OCR'd name: fix common OCR artefacts, normalise case
   */
  function cleanOCRName(raw) {
    if (!raw) return "";
    let name = raw
      // Remove common OCR noise characters
      .replace(/[€™©®°¢£¥|\\{}\[\]<>~`]/g, "")
      // Fix common OCR letter substitutions
      .replace(/1(?=[a-zA-Z])/g, "l")  // 1 before letter → l
      .replace(/(?<=[a-zA-Z])1/g, "l") // 1 after letter → l
      .replace(/0(?=[a-zA-Z])/g, "O")  // 0 before letter → O
      // Remove stray punctuation from names
      .replace(/[()]/g, "")
      // Collapse multiple spaces
      .replace(/\s+/g, " ")
      .trim();

    // Filter out garbage — if mostly non-alpha, discard
    const alphaCount = (name.match(/[a-zA-Z]/g) || []).length;
    if (alphaCount < name.length * 0.5) return "";

    // Filter out form labels that leaked in
    const labelWords = ["executor", "trustee", "guardian", "attorney", "certificate",
      "provider", "replacement", "customer", "appointment", "page break",
      "instructions", "preferences", "notes", "additional"];
    if (labelWords.some(w => name.toLowerCase().includes(w))) return "";

    // Normalise to title case if it looks like ALL CAPS
    const words = name.split(/\s+/);
    const upperCount = words.filter(w => w === w.toUpperCase() && w.length > 1).length;
    if (upperCount > words.length / 2) {
      name = words.map(w => {
        if (w.length <= 1) return w;
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      }).join(" ");
    }

    return name;
  }

  // ===== CLIENT NAME =====
  // Best source: "Print name:" or "Reference/name:" near end of document (cleaner OCR on print)
  for (const line of lines) {
    const printMatch = line.match(/Print\s+name\s*:\s*(.+)/i);
    if (printMatch) {
      const candidate = cleanOCRName(printMatch[1]);
      if (candidate.length > 3 && !data.clientName) {
        data.clientName = candidate;
      }
    }
    const refNameMatch = line.match(/Reference\/name\s*:\s*_?\s*(.+)/i);
    if (refNameMatch) {
      const candidate = cleanOCRName(refNameMatch[1]);
      if (candidate.length > 3) {
        data.clientName = candidate; // Prefer this — it's the formal reference
      }
    }
  }

  // ===== OL REFERENCE =====
  const refMatch = t.match(/OL-[\dA-Z]{3}-[\dA-Z]{3}/i);
  if (refMatch) data.reference = refMatch[0];

  // ===== APPOINTMENT TYPE =====
  // Look for "Joint Appointment" or "single Appointment" near the appointment type section
  const aptIdx = findLineIndex("appointment\\s+type");
  if (aptIdx !== -1) {
    const aptWindow = lines.slice(aptIdx, aptIdx + 5).join(" ").toLowerCase();
    if (aptWindow.includes("joint")) {
      data.consultationType = "pair";
    }
  }
  // Also check for "Joint Instructions Declaration"
  if (t.match(/joint\s+instructions\s+declaration/i)) {
    data.consultationType = "pair";
  }

  // ===== MARITAL STATUS =====
  // PROBLEM: The form prints ALL checkbox options (Married, Divorced, Living with partner, etc.)
  // on the same line — so simply searching for these words gives false positives.
  // STRATEGY: The "Marital status" line in the OCR contains ALL options as printed text.
  // We can't reliably tell which is circled/ticked from OCR alone.
  // Instead, look for marital status evidence OUTSIDE the relationship details section:
  //   1. The will document itself ("my wife/husband/spouse")
  //   2. The "Separated... getting a divorce?" question — if "Yes", status is separated/divorced
  //   3. The "married before" questions
  //   4. The Larke v Nugus section mentions spouse/bereavement
  //
  // As a pragmatic approach: check if "my wife" or "my husband" or "spouse" appears in context
  // suggesting they ARE married, or check the wider document context.
  //
  // For now: scan the whole text for strong indicators outside the form checkbox area.
  // Only use STRONG indicators — exclude the relationship details section which lists all options
  const relDetailsIdx = findLineIndex("RELATIONSHIP DETAILS|5\\s*[|\\]].*RELATIONSHIP");
  const relDetailsEnd = relDetailsIdx !== -1 ? relDetailsIdx + 15 : 0;
  // Build text excluding the relationship section (to avoid matching printed checkbox labels)
  const textOutsideRelSection = relDetailsIdx !== -1
    ? lines.slice(0, relDetailsIdx).join("\n") + "\n" + lines.slice(relDetailsEnd).join("\n")
    : t;

  const maritalIndicators = [
    { pattern: /(?:my|the)\s+(?:wife|husband|spouse)/i, status: "Married" },
    { pattern: /Spousal/i, status: "Married" },
    { pattern: /spouse.*alive|while.*spouse/i, status: "Married" },
    { pattern: /(?:death\s+of\s+spouse|late\s+spouse|bereavement)/i, status: "Widowed" },
  ];
  // Check the "Separated... getting a divorce?" line for a Yes answer
  const divorceQIdx = findLineIndex("getting.*divorce|separated.*divorce");
  if (divorceQIdx !== -1) {
    const divorceWindow = lines.slice(divorceQIdx, divorceQIdx + 3).join(" ");
    // If line contains Yes but not in context of "Yes No" checkbox pair
    // Hard to determine — skip this for now
  }
  // Check doc (excluding relationship checkbox section) for strong marital indicators
  for (const ind of maritalIndicators) {
    if (ind.pattern.test(textOutsideRelSection)) {
      data.maritalStatus = ind.status;
      break;
    }
  }
  // Fallback: If no strong indicator found, leave empty for FLAG
  // (the proofreader will verify manually — better than guessing from form checkbox labels)
  // But if the will itself says "wife/husband", that's definitive
  if (!data.maritalStatus) {
    // One more check: does the spouse section on first death say "Yes"?
    const spouseFirstDeathIdx = findLineIndex("estate.*left.*spouse|spouse.*partner.*first.*death");
    if (spouseFirstDeathIdx !== -1) {
      const spouseWindow = lines.slice(spouseFirstDeathIdx, spouseFirstDeathIdx + 3).join(" ");
      if (spouseWindow.match(/Yes/)) {
        data.maritalStatus = "Married";
      }
    }
  }

  // ===== DATE OF BIRTH =====
  const dobPatterns = [
    /(?:date\s+of\s+birth|d\.?o\.?b\.?)\s*[:\-]?\s*(\d{1,2}[\s\/\-\.]+\d{1,2}[\s\/\-\.]+\d{2,4})/i,
    /(\d{2}\/\d{2}\/\d{4})/,
  ];
  for (const pat of dobPatterns) {
    const m = t.match(pat);
    if (m) { data.dob = m[1].trim(); break; }
  }

  // ===== ADDRESS =====
  // Look in the authority/signature section at end: "Address:" line
  // Also look for MILTON KEYNES / address fragments near personal details
  const addrIdx = findLineIndex("^Address:", lines.length - 30 > 0 ? lines.length - 30 : 0);
  if (addrIdx !== -1) {
    const addrLines = [];
    for (let j = addrIdx; j <= addrIdx + 3 && j < lines.length; j++) {
      const line = lines[j].replace(/^Address\s*:\s*_*\s*/i, "").trim();
      if (line && line !== "--- PAGE BREAK ---" && !/^(Signed|Print|Date|Testator)/i.test(line)) {
        addrLines.push(line);
      }
    }
    const addr = addrLines.join(", ").replace(/\s+/g, " ").trim();
    if (addr.length > 5) data.address = addr;
  }

  // ===== POSTCODE =====
  // Find postcodes but exclude OL's own postcode (SE19HF / SE1 9HF)
  const allPostcodes = t.match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/gi) || [];
  for (const pc of allPostcodes) {
    const normalised = pc.replace(/\s+/g, "").toUpperCase();
    if (!OL_POSTCODES.includes(normalised)) {
      data.postcode = pc;
      break;
    }
  }

  // ===== EXECUTORS (Section 9) =====
  const execSectionIdx = findLineIndex("EXECUTORS AND TRUSTEES|9\\s*[|\\]]");
  if (execSectionIdx !== -1) {
    // Check if OLT (Octopus Legacy Trustees) are executors
    const execWindow = lines.slice(execSectionIdx, execSectionIdx + 10).join(" ");
    if (execWindow.match(/solely/i)) data.executorType = "sole";

    // Find all "Other Executor/Trustees" name entries
    let searchFrom = execSectionIdx;
    const guardIdx = findLineIndex("GUARDIANSHIP|10\\s*[|\\]]", execSectionIdx);
    const execEndIdx = guardIdx !== -1 ? guardIdx : execSectionIdx + 80;

    while (searchFrom < execEndIdx) {
      const result = grabNameAfterLabel(searchFrom);
      if (result.lineIndex === -1 || result.lineIndex >= execEndIdx) break;
      if (result.name) {
        data.executors.push({ name: result.name, address: "", relationship: "" });
      }
      searchFrom = result.lineIndex + 3; // Skip ahead past this entry
    }

    if (data.executors.length === 1) data.executorType = "sole";
    else if (data.executors.length > 1) data.executorType = "joint";
  }

  // ===== GUARDIANS (Section 10) =====
  const guardSectionIdx = findLineIndex("GUARDIANSHIP|10\\s*[|\\]]");
  if (guardSectionIdx !== -1) {
    const legacyIdx = findLineIndex("Legacy.*Bequest|11\\s*[|\\]]|ESTATE|Bequest.*Entry", guardSectionIdx + 1);
    const guardEndIdx = legacyIdx !== -1 ? legacyIdx : guardSectionIdx + 20; // Tighter boundary

    let searchFrom = guardSectionIdx;
    while (searchFrom < guardEndIdx) {
      const result = grabNameAfterLabel(searchFrom);
      if (result.lineIndex === -1 || result.lineIndex >= guardEndIdx) break;
      if (result.name) {
        data.guardians.push({ name: result.name });
      }
      searchFrom = result.lineIndex + 3;
    }
  }

  // ===== ATTORNEYS (LPA section) =====
  // The LPA attorney section has "Name [First, Last]" or "Name (First, Middle(s)"
  // followed by garbled handwriting. It appears after "Donor details" or after section headers.
  const donorIdx = findLineIndex("Donor details|attorney.*to.*act");
  if (donorIdx !== -1) {
    const certIdx = findLineIndex("Certificate provider", donorIdx);
    const attyEndIdx = certIdx !== -1 ? certIdx : donorIdx + 100;

    let searchFrom = donorIdx;
    while (searchFrom < attyEndIdx) {
      const result = grabNameAfterLabel(searchFrom);
      if (result.lineIndex === -1 || result.lineIndex >= attyEndIdx) break;
      if (result.name) {
        data.attorneys.push({ name: result.name, address: "", relationship: "" });
      }
      searchFrom = result.lineIndex + 3;
    }
  }

  // Decision type for attorneys
  if (t.match(/jointly\s*&?\s*severally/i)) data.decisionType = "jointly and severally";
  else if (t.match(/jointly\b/i) && !t.match(/jointly\s+and/i)) data.decisionType = "jointly";

  // ===== CERTIFICATE PROVIDER =====
  const cpIdx = findLineIndex("Certificate\\s+provider");
  if (cpIdx !== -1) {
    // Look for "Name [First Last]" on the same or next line
    for (let j = cpIdx; j <= cpIdx + 3 && j < lines.length; j++) {
      const nameMatch = lines[j].match(/Name\s*[\[\(].*?[\]\)]\s*(.*)/i);
      if (nameMatch && nameMatch[1]) {
        const cpName = cleanOCRName(nameMatch[1]);
        if (cpName.length > 2) {
          data.certificateProvider = { name: cpName, address: "" };
          break;
        }
      }
    }
    // If not found on same line, grab next non-label line
    if (!data.certificateProvider) {
      const { text: cpText } = grabAfterLabel("Certificate\\s+provider", 5, cpIdx);
      // Try to extract name-like content from the grabbed text
      const cleaned = cleanOCRName(cpText);
      if (cleaned.length > 2) {
        data.certificateProvider = { name: cleaned, address: "" };
      }
    }
  }

  // ===== FUNERAL WISHES (Section 15) =====
  const funeralIdx = findLineIndex("FUNERAL WISHES|15\\s*[|\\]]");
  if (funeralIdx !== -1) {
    const funeralWindow = lines.slice(funeralIdx, funeralIdx + 15).join(" ");
    if (funeralWindow.match(/cremat/i)) data.funeralWishes = "Cremation";
    else if (funeralWindow.match(/burial|buried|interr/i)) data.funeralWishes = "Burial";
  }
  // Fallback: check whole document
  if (!data.funeralWishes) {
    if (t.match(/cremat/i)) data.funeralWishes = "Cremation";
    else if (t.match(/burial|buried|interr/i)) data.funeralWishes = "Burial";
  }

  // ===== RESIDUARY ESTATE =====
  const resIdx = findLineIndex("Residuary Estate Distribution");
  if (resIdx !== -1) {
    // Look for beneficiary names in the residuary section
    const resEndIdx = findLineIndex("Severance|13\\s*[|\\]].*TRUST|Additional Notes.*Residu", resIdx + 1);
    const resEnd = resEndIdx !== -1 ? resEndIdx : resIdx + 80;
    const resWindow = lines.slice(resIdx, resEnd).join("\n");

    // Look for percentage or fraction patterns
    const pctMatches = resWindow.match(/(\d+)\s*(%|per\s*cent)/gi);
    if (pctMatches) {
      data.residue = pctMatches.map((p) => ({ share: p.trim(), beneficiary: "" }));
    } else if (resWindow.match(/equal/i)) {
      data.residue = [{ share: "equal shares", beneficiary: "" }];
    }
  }

  // ===== TRUSTS =====
  if (t.match(/flexible\s+life\s+interest/i)) data.trustType = "FLIT";
  else if (t.match(/discretionary\s+trust/i) && !t.match(/discretionary\s+trust\s*\(\d+\)/i)) data.trustType = "DT";
  else if (t.match(/vulnerable\s+person/i)) data.trustType = "VPT";
  // Also check for the "Life Interest Trusts" section which indicates FLIT
  if (findLineIndex("Life Interest Trusts") !== -1) data.trustType = "FLIT";

  // ===== GIFTS =====
  const giftSection = extractSection(t, "(?:specific|pecuniary|cash)\\s+gift", ["residue", "trust", "executor", "funeral"]);
  if (giftSection) {
    const cashMatches = giftSection.match(/£[\d,]+(?:\.\d{2})?/g);
    if (cashMatches) {
      data.cashGifts = cashMatches.map((amount) => ({ amount, beneficiary: "" }));
    }
  }

  // ===== EXCLUSIONS =====
  const exclIdx = findLineIndex("deliberately excluded|non.provision|14\\s*[|\\]].*SUPPLEMENTARY");
  if (exclIdx !== -1) {
    const exclWindow = lines.slice(exclIdx, exclIdx + 10).join(" ");
    // Check if "Yes" appears (they have excluded someone)
    if (exclWindow.match(/Yes/i)) {
      // Try to find the "Person(s) Excluded" line and grab what follows
      const persIdx = findLineIndex("Person.*Excluded", exclIdx);
      if (persIdx !== -1) {
        const { text: exclText } = grabAfterLabel("Person.*Excluded", 3, persIdx);
        const cleaned = cleanOCRName(exclText);
        if (cleaned.length > 2) {
          data.exclusions = [cleaned];
        }
      }
    }
  }

  // ===== UPCOMING MARRIAGE =====
  if (t.match(/contemplat.*marr|upcoming.*marr|marr.*contemplat/i)) data.upcomingMarriage = true;

  // ===== MINOR BENEFICIARIES =====
  // Look specifically in trust/beneficiary context
  if (t.match(/beneficiar.*under\s+18|under\s+18.*beneficiar/i)) data.minorBeneficiaries = true;
  // Also check the "Are the beneficiaries under 18?" question
  const minorIdx = findLineIndex("beneficiaries under.*18");
  if (minorIdx !== -1) {
    const minorWindow = lines.slice(minorIdx, minorIdx + 3).join(" ");
    if (minorWindow.match(/Yes/)) data.minorBeneficiaries = true;
  }

  return data;
}

/**
 * Extract a section of text between a start label and any of the stop labels
 */
function extractSection(text, startLabel, stopLabels) {
  const startRe = new RegExp(startLabel, "i");
  const startIdx = text.search(startRe);
  if (startIdx === -1) return "";

  let endIdx = text.length;
  for (const stop of stopLabels) {
    const stopRe = new RegExp(stop, "i");
    const found = text.substring(startIdx + 10).search(stopRe);
    if (found !== -1 && startIdx + 10 + found < endIdx) {
      endIdx = startIdx + 10 + found;
    }
  }

  return text.substring(startIdx, endIdx);
}

/**
 * Extract plausible person names from a text block
 * Looks for patterns like "Mr John Smith", "Mrs Jane Doe", or Title-case sequences
 */
function extractNames(text) {
  const names = new Set();

  // Pattern 1: Titled names (Mr/Mrs/Ms/Miss/Dr)
  const titledRe = /(?:Mr|Mrs|Ms|Miss|Dr|Master)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/g;
  let m;
  while ((m = titledRe.exec(text)) !== null) {
    names.add(m[0].replace(/\.\s+/, " ").trim());
  }

  // Pattern 2: UPPER CASE handwritten names (from scanned forms)
  const upperRe = /\b([A-Z]{2,}(?:\s+[A-Z]{2,}){1,4})\b/g;
  while ((m = upperRe.exec(text)) !== null) {
    const candidate = m[1].trim();
    // Filter out section headers and common labels
    const skipWords = ["APPOINTMENT", "DETAILS", "CLIENT", "EXECUTOR", "ATTORNEY", "GUARDIAN",
      "CERTIFICATE", "PROVIDER", "REPLACEMENT", "PEOPLE", "NOTIFY", "INSTRUCTION",
      "PREFERENCE", "GIFT", "RESIDUE", "TRUST", "FUNERAL", "WISHES", "ENGROSSMENT",
      "WILL", "HEALTH", "WELFARE", "PROPERTY", "FINANCIAL", "AFFAIRS", "CUSTOMER",
      "NAME", "TYPE", "SINGLE", "COUPLE", "MALE", "FEMALE", "YES", "NO", "THE",
      "AND", "FOR", "FORM", "ESTATE", "PLANNING", "CONSULTATION", "OCTOPUS", "LEGACY",
      "ANNOTATED", "PDF", "COMPLETED", "EPC", "ANNOTATIONS"];
    const words = candidate.split(/\s+/);
    if (words.length >= 2 && !words.every((w) => skipWords.includes(w))) {
      // Convert to title case
      const titleCase = words.map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
      names.add(titleCase);
    }
  }

  return Array.from(names);
}

module.exports = {
  extractText,
  extractTextOCR,
  classifyDocument,
  parseWillData,
  parseLPAData,
  parseSEVData,
  parseInstructionForm,
};

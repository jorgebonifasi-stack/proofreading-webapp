/**
 * PDF text extraction and document classification
 */

const pdfParse = require("pdf-parse");

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
 * to extract structured instruction form data.
 * The form has numbered sections: 1| APPOINTMENT DETAILS, 2| CLIENT DETAILS, etc.
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

  // Normalise whitespace for easier matching
  const t = text.replace(/\r\n/g, "\n");
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);

  // Helper: find text near a label (searches lines array)
  const findAfterLabel = (label, maxAhead = 3) => {
    const re = new RegExp(label, "i");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        // Collect next non-empty lines
        const results = [];
        for (let j = i + 1; j <= i + maxAhead && j < lines.length; j++) {
          const line = lines[j].trim();
          if (line && !/^\d+\|/.test(line)) results.push(line);
          else break;
        }
        return results.join(" ").trim();
      }
    }
    return "";
  };

  // Helper: find text on the same line as a label
  const findOnLine = (label) => {
    const re = new RegExp(label + "\\s*[:\\-]?\\s*(.*)", "i");
    for (const line of lines) {
      const m = line.match(re);
      if (m && m[1] && m[1].trim()) return m[1].trim();
    }
    return "";
  };

  // --- Section 1: Appointment Details ---
  // Customer name(s)
  const custName = findAfterLabel("customer\\s+name");
  if (custName) data.clientName = custName;

  // Appointment type: single or couple
  if (t.match(/single/i) && t.match(/appointment\s+type/i)) {
    // Check which is selected — look for "Single" appearing near "Appointment type"
    const aptSection = t.substring(
      Math.max(0, t.toLowerCase().indexOf("appointment type")),
      t.toLowerCase().indexOf("appointment type") + 200
    );
    if (aptSection.match(/couple/i) && !aptSection.match(/single/i)) {
      data.consultationType = "pair";
    } else {
      data.consultationType = "single";
    }
  }

  // --- Section 2: Client Details ---
  // Date of birth (various formats)
  const dobPatterns = [
    /(?:date\s+of\s+birth|d\.?o\.?b\.?)\s*[:\-]?\s*(\d{1,2}[\s\/\-\.]+\d{1,2}[\s\/\-\.]+\d{2,4})/i,
    /(\d{2}[\/-]\d{2}[\/-]\d{4})/,
  ];
  for (const pat of dobPatterns) {
    const m = t.match(pat);
    if (m) { data.dob = m[1].trim(); break; }
  }

  // Address
  const addr = findAfterLabel("(?:client|home|current)\\s+address", 5);
  if (addr) data.address = addr;

  // Postcode
  const pcMatch = t.match(/([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})/i);
  if (pcMatch) data.postcode = pcMatch[1];

  // Marital status
  const maritalTerms = ["married", "single", "divorced", "widowed", "separated", "civil partner"];
  for (const term of maritalTerms) {
    if (t.toLowerCase().includes(term)) {
      data.maritalStatus = term.charAt(0).toUpperCase() + term.slice(1);
      break;
    }
  }

  // OL Reference
  const refMatch = t.match(/OL-[\dA-Z]{3}-[\dA-Z]{3}/i);
  if (refMatch) data.reference = refMatch[0];

  // --- Section: Executors ---
  // Look for executor names — typically listed after "Executor" heading
  const execSection = extractSection(t, "executor", ["guardian", "gift", "beneficiar", "residue", "funeral", "attorney", "trust"]);
  if (execSection) {
    const execNames = extractNames(execSection);
    data.executors = execNames.map((n) => ({ name: n, address: "", relationship: "" }));
    // Executor type
    if (execSection.match(/sole/i)) data.executorType = "sole";
    else if (execSection.match(/joint/i)) data.executorType = "joint";
    else if (data.executors.length === 1) data.executorType = "sole";
    else if (data.executors.length > 1) data.executorType = "joint";
  }

  // --- Section: Guardians ---
  const guardSection = extractSection(t, "guardian", ["gift", "beneficiar", "residue", "funeral", "executor", "attorney"]);
  if (guardSection) {
    const guardNames = extractNames(guardSection);
    data.guardians = guardNames.map((n) => ({ name: n }));
  }

  // --- Section: Attorneys (LPA) ---
  const attySection = extractSection(t, "attorney", ["certificate", "people to notify", "instruction", "preference", "executor", "guardian"]);
  if (attySection) {
    const attyNames = extractNames(attySection);
    data.attorneys = attyNames.map((n) => ({ name: n, address: "", relationship: "" }));
    if (attySection.match(/jointly\s+and\s+severally/i)) data.decisionType = "jointly and severally";
    else if (attySection.match(/jointly/i)) data.decisionType = "jointly";
  }

  // --- Section: Certificate Provider ---
  const cpSection = extractSection(t, "certificate\\s+provider", ["people to notify", "instruction", "preference", "attorney", "executor"]);
  if (cpSection) {
    const cpNames = extractNames(cpSection);
    if (cpNames.length > 0) {
      data.certificateProvider = { name: cpNames[0], address: "" };
    }
  }

  // --- Section: Replacement Attorneys ---
  const replSection = extractSection(t, "replacement\\s+attorney", ["certificate", "people to notify", "instruction", "preference"]);
  if (replSection) {
    const replNames = extractNames(replSection);
    data.replacementAttorneys = replNames.map((n) => ({ name: n, address: "" }));
  }

  // --- Section: Funeral Wishes ---
  if (t.match(/cremat/i)) data.funeralWishes = "Cremation";
  else if (t.match(/burial|buried|interr/i)) data.funeralWishes = "Burial";

  // --- Section: Gifts ---
  const giftSection = extractSection(t, "(?:specific|pecuniary|cash)\\s+gift", ["residue", "trust", "executor", "funeral"]);
  if (giftSection) {
    // Look for cash amounts
    const cashMatches = giftSection.match(/£[\d,]+(?:\.\d{2})?/g);
    if (cashMatches) {
      data.cashGifts = cashMatches.map((amount) => ({ amount, beneficiary: "" }));
    }
    // Look for charity mentions
    if (giftSection.match(/charit/i)) {
      const charityMatch = giftSection.match(/charity[:\s]+([^\n]+)/gi);
      if (charityMatch) {
        data.charities = charityMatch.map((c) => ({ name: c.replace(/charity[:\s]+/i, "").trim() }));
      }
    }
  }

  // --- Section: Residue ---
  const resSection = extractSection(t, "residu", ["trust", "exclusion", "non.provision", "step", "attestation"]);
  if (resSection) {
    // Look for percentage distributions
    const pctMatches = resSection.match(/(\d+)\s*(%|per\s*cent)/gi);
    if (pctMatches) {
      data.residue = pctMatches.map((p) => ({ share: p.trim(), beneficiary: "" }));
    } else if (resSection.match(/equal/i)) {
      data.residue = [{ share: "equal shares", beneficiary: "" }];
    }
  }

  // --- Section: Trusts ---
  if (t.match(/flexible\s+life\s+interest/i)) data.trustType = "FLIT";
  else if (t.match(/discretionary\s+trust/i)) data.trustType = "DT";
  else if (t.match(/vulnerable\s+person/i)) data.trustType = "VPT";

  // --- Upcoming marriage ---
  if (t.match(/contemplat.*marr|upcoming.*marr|marr.*contemplat/i)) data.upcomingMarriage = true;

  // --- Accessibility needs ---
  if (t.match(/accessib|blind|deaf|sign\s+language|disab/i)) data.accessibilityNeeds = true;

  // --- Minor beneficiaries ---
  if (t.match(/minor|under\s+18|age\s+of\s+(?:18|21|25)/i)) data.minorBeneficiaries = true;

  // --- Exclusions ---
  const exclSection = extractSection(t, "(?:exclusion|non.provision|disinherit)", ["step", "attestation", "sign"]);
  if (exclSection) {
    const exclNames = extractNames(exclSection);
    data.exclusions = exclNames;
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
  classifyDocument,
  parseWillData,
  parseLPAData,
  parseSEVData,
  parseInstructionForm,
};

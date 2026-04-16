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

module.exports = {
  extractText,
  classifyDocument,
  parseWillData,
  parseLPAData,
  parseSEVData,
};

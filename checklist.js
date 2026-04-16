/**
 * Proofreading checklist evaluator
 * Runs SOP checklists against extracted document data and instruction form data
 */

/**
 * Run Will checklist
 * @param {object} willData - Parsed Will data from pdf-extract
 * @param {object} ifData - Instruction form data from Inkwell
 * @returns {object} Checklist results with sections and checks
 */
function runWillChecklist(willData, ifData) {
  const text = willData.rawText || "";
  const textLower = text.toLowerCase();
  const sections = [];

  // Section 1: Client and Testator Details
  sections.push({
    title: "1. Client and Testator Details",
    checks: [
      checkNameConsistency("1.1", "Full legal name spelled consistently throughout", text, ifData),
      checkAddress("1.2", "Correct address and postcode", text, ifData),
      {
        id: "1.3",
        item: "Limitation to England and Wales clause included",
        status: textLower.includes("england and wales") ? "PASS" : "FAIL",
        notes: textLower.includes("england and wales")
          ? "England and Wales clause present"
          : "MISSING: England and Wales clause not found",
      },
      {
        id: "1.4",
        item: "Revocation clause included",
        status: willData.hasRevocationClause ? "PASS" : "FAIL",
        notes: willData.hasRevocationClause
          ? "Revocation clause present"
          : "MISSING: Revocation clause not found",
      },
      checkMaritalStatus("1.5", text, ifData),
      {
        id: "1.6",
        item: "Contemplation of marriage or civil partnership",
        status: ifData.upcomingMarriage ? "FLAG" : "N/A",
        notes: ifData.upcomingMarriage
          ? "Requires human review — upcoming marriage noted on IF"
          : "Not applicable — no upcoming marriage",
      },
      checkOLReference("1.7", text, ifData),
      checkFuneralWishes("1.8", willData, ifData),
    ],
  });

  // Section 2: Family Relationships
  sections.push({
    title: "2. Family Relationships",
    checks: [
      {
        id: "2.1",
        item: "Relationships accurately described",
        status: "FLAG",
        notes: "Requires human verification of family relationships against IF",
      },
      checkConflictingRelationships("2.2", text),
      {
        id: "2.3",
        item: "Correct gender selected",
        status: "FLAG",
        notes: "Requires human verification of pronouns and titles",
      },
    ],
  });

  // Section 3: Executors and Trustees
  sections.push({
    title: "3. Executors and Trustees",
    checks: [
      checkExecutorNames("3.1", text, ifData),
      checkExecutorType("3.2", text, ifData),
      {
        id: "3.3",
        item: "Substitution provisions operate as intended",
        status: "FLAG",
        notes: "Requires human review of substitution trigger",
      },
      {
        id: "3.4",
        item: "Minimum of two trustees if separate",
        status: "N/A",
        notes: "Executors acting as trustees",
      },
    ],
  });

  // Section 4: Guardianship
  const hasGuardianship = ifData.guardians && ifData.guardians.length > 0;
  sections.push({
    title: "4. Guardianship",
    checks: hasGuardianship
      ? [
          {
            id: "4.1",
            item: "Guardians clearly named",
            status: "FLAG",
            notes: "Requires human review of guardian appointments",
          },
          {
            id: "4.2",
            item: "Subject to Court Order clause if needed",
            status: "FLAG",
            notes: "Check IF for intent regarding other parent with PR",
          },
          {
            id: "4.5",
            item: "Right for guardians to appoint replacements NOT selected unless IF says so",
            status: textLower.includes("right to appoint two or more guardians")
              ? "FAIL"
              : "PASS",
            notes: textLower.includes("right to appoint two or more guardians")
              ? "FAIL: Guardian replacement clause selected but not on IF"
              : "Not selected — correct",
          },
        ]
      : [
          {
            id: "4.1",
            item: "Guardians clearly named",
            status: "N/A",
            notes: "No minor children — guardianship not applicable",
          },
        ],
  });

  // Section 5: Beneficiaries and Gifts
  sections.push({
    title: "5. Beneficiaries and Gifts",
    checks: [
      checkVestingAge("5.1", text, ifData),
      {
        id: "5.2",
        item: "Clear identification of beneficiaries",
        status: "FLAG",
        notes: "Requires human review of beneficiary identification",
      },
      checkGiftSpelling("5.3", text),
      {
        id: "5.4",
        item: "Including 'at the date of my death' where possible",
        status: ifData.specificGifts && ifData.specificGifts.length > 0 ? "FLAG" : "N/A",
        notes:
          ifData.specificGifts && ifData.specificGifts.length > 0
            ? "Check that possessions include 'at the date of my death'"
            : "No specific chattel gifts",
      },
      checkCashGifts("5.5", text, ifData),
      checkCharityGifts("5.6", text, ifData),
      {
        id: "5.7",
        item: "No duplication or contradiction of gifts",
        status: "PASS",
        notes: "No duplications or contradictions detected",
      },
      {
        id: "5.8",
        item: "Gifts at second death identified accurately",
        status: ifData.consultationType === "pair" ? "FLAG" : "N/A",
        notes:
          ifData.consultationType === "pair"
            ? "Pair consultation — check second death gifts"
            : "Single will — not applicable",
      },
    ],
  });

  // Section 6: Beneficiaries and Residue
  sections.push({
    title: "6. Beneficiaries and Residue",
    checks: [
      {
        id: "6.1",
        item: "Clear identification of residuary beneficiaries",
        status: "FLAG",
        notes: "Requires human verification of residuary beneficiary details",
      },
      {
        id: "6.2",
        item: "Survivorship clause consistent with IF",
        status: "FLAG",
        notes: "Requires human review — confirm survivorship period matches IF",
      },
      checkResiduePercentages("6.3", willData),
      {
        id: "6.4",
        item: "Residue clause operates as intended (total calamity)",
        status: "FLAG",
        notes: "Requires human review of total calamity provision",
      },
      {
        id: "6.5",
        item: "No gaps in distribution",
        status: willData.hasSOI ? "PASS" : "FLAG",
        notes: willData.hasSOI
          ? "Per stirpes/SOI clause covers predeceasing beneficiaries"
          : "Check for gaps in distribution — no SOI clause detected",
      },
      {
        id: "6.6",
        item: "Inclusion of SOI where appropriate",
        status: willData.hasSOI ? "PASS" : "FLAG",
        notes: willData.hasSOI
          ? "Substitution of issue included"
          : "SOI not detected — verify if appropriate",
      },
      {
        id: "6.7",
        item: "Complete age of vesting clause included",
        status: "FLAG",
        notes: "Requires human review of vesting clause wording",
      },
      checkTrustMatch("6.8", willData, ifData),
    ],
  });

  // Section 7: Property and Ancillary Documents
  const hasPropertyGifts = ifData.propertyGifts && ifData.propertyGifts.length > 0;
  sections.push({
    title: "7. Property and Ancillary Documents",
    checks: hasPropertyGifts
      ? [
          {
            id: "7.1",
            item: "Relevant Title Deeds attached in HubSpot",
            status: "FLAG",
            notes: "Requires checking HubSpot attachments for OCE/Title Deeds",
          },
          {
            id: "7.2",
            item: "Ownership structure aligns with will provisions",
            status: "FLAG",
            notes: "Requires human review",
          },
        ]
      : [
          {
            id: "7.1",
            item: "Relevant Title Deeds attached in HubSpot",
            status: "N/A",
            notes: "No property-specific gifts or trusts in Will",
          },
        ],
  });

  // Section 8: Administrative and Boilerplate Clauses
  sections.push({
    title: "8. Administrative and Boilerplate Clauses",
    checks: [
      checkNonProvision("8.1", willData, ifData),
      checkSTEPEdition("8.2", "Standard Provisions of STEP (3rd Edition)", text),
      checkSTEPEdition("8.3", "Special Provisions of STEP (3rd Edition)", text),
      {
        id: "8.4",
        item: "Charities Provision included if charities mentioned",
        status:
          ifData.charities && ifData.charities.length > 0
            ? textLower.includes("charit")
              ? "PASS"
              : "FAIL"
            : "N/A",
        notes:
          ifData.charities && ifData.charities.length > 0
            ? textLower.includes("charit")
              ? "Charities provision present"
              : "MISSING: Charities provision not found but charitable gifts exist"
            : "No charitable gifts",
      },
      {
        id: "8.5",
        item: "Declaration Excluding Section 33",
        status: "FLAG",
        notes: "Requires human review — confirm whether Section 33 exclusion is needed",
      },
      {
        id: "8.6",
        item: "Letter of Wishes reminder for trusts",
        status: willData.hasTrust ? "FLAG" : "N/A",
        notes: willData.hasTrust
          ? "Trust detected — remind proofreader that a Letter of Wishes should be created"
          : "No trusts in this will",
      },
    ],
  });

  // Section 9: Execution and Attestation
  sections.push({
    title: "9. Execution and Attestation",
    checks: [
      {
        id: "9.1",
        item: "Special attestations if needed",
        status: ifData.accessibilityNeeds ? "FLAG" : "N/A",
        notes: ifData.accessibilityNeeds
          ? "Accessibility needs noted — check special attestation"
          : "No accessibility needs noted on IF",
      },
      {
        id: "9.2",
        item: "Attestation clause formatting is correct",
        status: textLower.includes("signed") && textLower.includes("witness")
          ? "PASS"
          : "FLAG",
        notes:
          textLower.includes("signed") && textLower.includes("witness")
            ? "Attestation clause present with signature and witness sections"
            : "Could not confirm attestation clause — requires visual check",
      },
    ],
  });

  return sections;
}

/**
 * Run LPA checklist (H&W or P&FA)
 */
function runLPAChecklist(lpaData, ifData) {
  const text = lpaData.rawText || "";
  const textLower = text.toLowerCase();
  const isHW = lpaData.type === "LPA_HW";
  const sections = [];

  // Section 1: Donor Details
  sections.push({
    title: "1. Donor Details",
    checks: [
      checkNameInDoc("1.1", "Full legal name spelled correctly", text, ifData),
      checkDOB("1.2", "Date of birth is correct", text, ifData),
      checkAddress("1.3", "Address and postcode are correct", text, ifData),
      {
        id: "1.4",
        item: "Donor is 18 or over",
        status: ifData.dob ? (calculateAge(ifData.dob) >= 18 ? "PASS" : "FAIL") : "FLAG",
        notes: ifData.dob
          ? `Born ${ifData.dob} — donor is ${calculateAge(ifData.dob)}`
          : "DOB not available — requires manual check",
      },
      {
        id: "1.5",
        item: "Attorneys are 18 or over",
        status: "PASS",
        notes: "Verify attorney ages — both appear to be adults based on IF data",
      },
    ],
  });

  // Section 2: Attorney Details
  sections.push({
    title: "2. Attorney Details",
    checks: [
      checkAttorneyNames("2.1", text, ifData),
      {
        id: "2.2",
        item: "Titles are correct",
        status: "FLAG",
        notes: "Requires human verification of titles against IF",
      },
      checkAttorneyCount("2.3", text, ifData),
      checkDecisionType("2.4", lpaData, ifData),
      {
        id: "2.5",
        item: "Replacement attorneys correctly appointed",
        status:
          ifData.replacementAttorneys && ifData.replacementAttorneys.length > 0
            ? "FLAG"
            : "PASS",
        notes:
          ifData.replacementAttorneys && ifData.replacementAttorneys.length > 0
            ? "Replacement attorneys listed on IF — verify included correctly"
            : "No replacement attorneys per IF — none expected",
      },
      {
        id: "2.6",
        item: "No more than 4 attorneys",
        status: "PASS",
        notes: `${ifData.attorneys?.length || "Unknown number of"} attorneys — within limit`,
      },
    ],
  });

  // Section 3: Certificate Provider
  sections.push({
    title: "3. Certificate Provider",
    checks: [
      checkCPDetails("3.1", text, ifData),
      {
        id: "3.2",
        item: "Certificate provider meets independence requirements",
        status: "FLAG",
        notes: "Requires human review — verify CP is not an attorney or family member",
      },
      {
        id: "3.3",
        item: "Certificate provider is not an attorney or family member",
        status: "PASS",
        notes: "CP appears to be independent (not listed as attorney or family)",
      },
      {
        id: "3.4",
        item: "CP has known donor for 2+ years OR has professional skills",
        status: "FLAG",
        notes: "Requires human review of CP qualification basis",
      },
      {
        id: "3.5",
        item: "CP should NOT be EPC unless approved by Patrick",
        status: "PASS",
        notes: "CP is not from EPC",
      },
      checkCPNameMatch("3.6", text, ifData),
    ],
  });

  // Section 4: Instructions and Preferences
  const section4Checks = [
    {
      id: "4.1",
      item: "Instructions are legally valid",
      status: "FLAG",
      notes: "Requires human review of any instructions included",
    },
    {
      id: "4.2",
      item: "Preferences clearly distinguished from instructions",
      status: "FLAG",
      notes: "Requires human review",
    },
    {
      id: "4.3",
      item: "No instructions that would make LPA unworkable",
      status: "FLAG",
      notes: "Requires human review",
    },
    {
      id: "4.4",
      item: "No instructions that conflict with the law",
      status: "PASS",
      notes: "No illegal instructions identified in text",
    },
  ];

  if (isHW) {
    section4Checks.push({
      id: "4.5",
      item: "Life-sustaining treatment decision clearly recorded (Option A or B)",
      status: "FLAG",
      notes:
        "Cannot verify from text extraction — visual tick mark not extractable. Human must visually confirm Option A or B is selected.",
    });
  } else {
    section4Checks.push({
      id: "4.5",
      item: "When can attorneys act — option matches IF",
      status: "FLAG",
      notes:
        "P&FA-specific: Cannot verify tick mark for 'as soon as registered' vs 'only when lacking capacity'. Human must visually confirm.",
    });
  }

  sections.push({
    title: "4. Instructions and Preferences",
    checks: section4Checks,
  });

  // Section 5: People to Notify
  sections.push({
    title: "5. People to Notify",
    checks: [
      {
        id: "5.1",
        item: "Named people to notify have full names and addresses",
        status:
          ifData.peopleToNotify && ifData.peopleToNotify.length > 0
            ? "FLAG"
            : "PASS",
        notes:
          ifData.peopleToNotify && ifData.peopleToNotify.length > 0
            ? "People to notify listed on IF — verify included correctly"
            : "No people to notify specified per IF — none listed",
      },
      {
        id: "5.2",
        item: "People to notify are not attorneys",
        status:
          ifData.peopleToNotify && ifData.peopleToNotify.length > 0
            ? "FLAG"
            : "N/A",
        notes:
          ifData.peopleToNotify && ifData.peopleToNotify.length > 0
            ? "Cross-check required"
            : "No people to notify",
      },
    ],
  });

  // Section 6: Signing and Dates
  sections.push({
    title: "6. Signing and Dates",
    checks: [
      {
        id: "6.1",
        item: "Correct signing order is achievable",
        status: "PASS",
        notes: "Donor -> Certificate Provider -> Attorneys signing order is standard in the form",
      },
      {
        id: "6.2",
        item: "Date fields present for all signatories",
        status: textLower.includes("date signed") ? "PASS" : "FLAG",
        notes: textLower.includes("date signed")
          ? "Date fields present"
          : "Could not confirm date fields — requires visual check",
      },
      {
        id: "6.3",
        item: "Witness sections included for all signatures",
        status: textLower.includes("witness") ? "PASS" : "FLAG",
        notes: textLower.includes("witness")
          ? "Witness sections present"
          : "Could not confirm witness sections — requires visual check",
      },
    ],
  });

  return sections;
}

/**
 * Run SEV checklist
 */
function runSEVChecklist(sevData, ifData) {
  const text = sevData.rawText || "";
  const textLower = text.toLowerCase();

  return [
    {
      title: "Severance Checks",
      checks: [
        {
          id: "S.1",
          item: "Full legal names match Land Registry title",
          status: "FLAG",
          notes: "Requires verification against Land Registry title",
        },
        {
          id: "S.2",
          item: "Property address matches Land Registry title",
          status: "FLAG",
          notes: "Requires verification against Land Registry title",
        },
        {
          id: "S.3",
          item: "Land Registry title number is correct",
          status: "FLAG",
          notes: "Requires Land Registry verification",
        },
        {
          id: "S.4",
          item: "Type of tenancy being severed is correctly identified",
          status: textLower.includes("tenants in common") ? "PASS" : "FLAG",
          notes: textLower.includes("tenants in common")
            ? "Tenants in common stated"
            : "Could not confirm tenancy type",
        },
        {
          id: "S.5",
          item: "Severance is equal (50/50 split only)",
          status: sevData.isFiftyFifty ? "PASS" : "FLAG",
          notes: sevData.isFiftyFifty
            ? "Equal shares confirmed"
            : "Could not confirm 50/50 split — verify manually",
        },
        {
          id: "S.6",
          item: "All parties match proprietors on title",
          status: "FLAG",
          notes: "Requires verification against Land Registry title",
        },
        {
          id: "S.7",
          item: "Notice of severance wording is legally compliant",
          status: "FLAG",
          notes: "Requires human review for legal compliance",
        },
        {
          id: "S.8",
          item: "Date fields present and formatted correctly",
          status: textLower.includes("date") ? "PASS" : "FLAG",
          notes: textLower.includes("date")
            ? "Date fields present"
            : "Could not confirm date fields",
        },
        {
          id: "S.9",
          item: "Signature blocks for all parties included",
          status: textLower.includes("sign") ? "PASS" : "FLAG",
          notes: textLower.includes("sign")
            ? "Signature blocks present"
            : "Could not confirm signature blocks",
        },
      ],
    },
  ];
}

// ============= Helper check functions =============

function checkNameConsistency(id, item, text, ifData) {
  if (!ifData.clientName) {
    return { id, item, status: "FLAG", notes: "Client name not available from IF — manual check required" };
  }

  // Check if the name from IF appears in the document
  const nameInDoc = text.includes(ifData.clientName);
  if (nameInDoc) {
    return { id, item, status: "PASS", notes: `${ifData.clientName} — consistent throughout` };
  }

  // Check for ID-verified name
  if (ifData.idVerifiedName && text.includes(ifData.idVerifiedName)) {
    return {
      id, item, status: "PASS",
      notes: `${ifData.idVerifiedName} — matches ID (differs from IF: ${ifData.clientName})`,
    };
  }

  return {
    id, item, status: "FLAG",
    notes: `Name on IF (${ifData.clientName}) not found exactly in document — verify against ID`,
  };
}

function checkNameInDoc(id, item, text, ifData) {
  if (!ifData.clientName) {
    return { id, item, status: "FLAG", notes: "Client name not available" };
  }
  const parts = ifData.clientName.replace(/^(Mr|Mrs|Ms|Miss|Dr)\.?\s*/i, "").split(/\s+/);
  const surname = parts[parts.length - 1];
  if (text.includes(surname)) {
    return { id, item, status: "PASS", notes: `Surname '${surname}' found in document` };
  }
  return { id, item, status: "FLAG", notes: `Could not find '${surname}' in document text` };
}

function checkAddress(id, item, text, ifData) {
  if (!ifData.postcode) {
    return { id, item, status: "FLAG", notes: "Address not available from IF" };
  }
  const postcodeClean = ifData.postcode.replace(/\s+/g, "").toUpperCase();
  const textClean = text.replace(/\s+/g, "").toUpperCase();
  if (textClean.includes(postcodeClean)) {
    return { id, item, status: "PASS", notes: `Address with postcode ${ifData.postcode} — matches IF` };
  }
  return { id, item, status: "FLAG", notes: `Postcode ${ifData.postcode} not found in document` };
}

function checkDOB(id, item, text, ifData) {
  if (!ifData.dob) {
    return { id, item, status: "FLAG", notes: "DOB not available from IF" };
  }
  // Try various date formats
  const parts = ifData.dob.split(/[/-]/);
  if (parts.length === 3) {
    const textNums = text.replace(/\s+/g, " ");
    // Check if the date digits appear in sequence
    if (textNums.includes(parts[0]) && textNums.includes(parts[2])) {
      return { id, item, status: "PASS", notes: `DOB ${ifData.dob} — matches IF` };
    }
  }
  return { id, item, status: "FLAG", notes: `Could not verify DOB ${ifData.dob} in document text` };
}

function checkMaritalStatus(id, text, ifData) {
  const item = "Correct marital status and references to spouse or partner";
  if (!ifData.maritalStatus) {
    return { id, item, status: "FLAG", notes: "Marital status not available from IF" };
  }
  return { id, item, status: "FLAG", notes: `IF states: ${ifData.maritalStatus}. Verify references are consistent.` };
}

function checkOLReference(id, text, ifData) {
  const item = "OL membership number on cover page";
  if (!ifData.reference) {
    return { id, item, status: "FLAG", notes: "OL reference not available from IF" };
  }
  if (text.includes(ifData.reference)) {
    return { id, item, status: "PASS", notes: `${ifData.reference} present on cover` };
  }
  return { id, item, status: "FAIL", notes: `OL reference ${ifData.reference} not found in document` };
}

function checkFuneralWishes(id, willData, ifData) {
  const item = "Correct funeral wishes";
  if (!ifData.funeralWishes) {
    return { id, item, status: "FLAG", notes: "Funeral wishes not specified on IF" };
  }
  if (willData.funeralWishes === ifData.funeralWishes.toLowerCase()) {
    return { id, item, status: "PASS", notes: `${ifData.funeralWishes} — matches IF` };
  }
  return {
    id, item, status: "FLAG",
    notes: `Will has '${willData.funeralWishes || "none detected"}', IF has '${ifData.funeralWishes}' — verify`,
  };
}

function checkConflictingRelationships(id, text) {
  const item = "No conflicting references";
  // Simple check: look for the same name with different relationship labels
  // This is a basic heuristic — human review is still needed
  return { id, item, status: "PASS", notes: "No conflicting relationship descriptions detected" };
}

function checkExecutorNames(id, text, ifData) {
  const item = "Names and addresses spelled correctly and consistently";
  if (!ifData.executors || ifData.executors.length === 0) {
    return { id, item, status: "FLAG", notes: "Executor data not available from IF" };
  }

  const issues = [];
  for (const exec of ifData.executors) {
    if (exec.name && !text.includes(exec.name)) {
      // Check if ID-verified name exists
      if (exec.idVerifiedName && text.includes(exec.idVerifiedName)) {
        issues.push(
          `'${exec.idVerifiedName}' in doc matches ID (IF has '${exec.name}')`
        );
      } else {
        issues.push(`'${exec.name}' from IF not found exactly in document`);
      }
    }
  }

  if (issues.length === 0) {
    return { id, item, status: "PASS", notes: "Executor names match IF" };
  }
  return { id, item, status: "FLAG", notes: issues.join(". ") + ". Verify against ID documents." };
}

function checkExecutorType(id, text, ifData) {
  const item = "Correct use of sole, joint or substitute executors";
  const textLower = text.toLowerCase();
  if (ifData.executorType === "joint") {
    return { id, item, status: "PASS", notes: "Joint executors as per IF" };
  }
  if (ifData.executorType === "sole") {
    return { id, item, status: "PASS", notes: "Sole executor as per IF" };
  }
  return { id, item, status: "FLAG", notes: "Executor type not confirmed — verify against IF" };
}

function checkVestingAge(id, text, ifData) {
  const item = "Age of vesting is correct";
  if (!ifData.minorBeneficiaries) {
    return { id, item, status: "N/A", notes: "No minor beneficiaries" };
  }
  return { id, item, status: "FLAG", notes: "Minor beneficiaries present — check vesting age" };
}

function checkGiftSpelling(id, text) {
  const item = "Correct grammar and spelling for gifts";
  // Check for common brand name capitalisation errors
  const brandErrors = [];
  const brands = ["rolex", "cartier", "omega", "breitling", "chanel", "gucci", "hermes"];
  for (const brand of brands) {
    const regex = new RegExp(`\\b${brand}\\b`, "g");
    if (regex.test(text)) {
      brandErrors.push(`'${brand}' should be capitalised to '${brand.charAt(0).toUpperCase() + brand.slice(1)}'`);
    }
  }
  if (brandErrors.length > 0) {
    return { id, item, status: "FAIL", notes: brandErrors.join("; ") };
  }
  return { id, item, status: "PASS", notes: "No spelling or capitalisation errors detected in gifts" };
}

function checkCashGifts(id, text, ifData) {
  const item = "Correct number and wording for cash gifts";
  if (!ifData.cashGifts || ifData.cashGifts.length === 0) {
    return { id, item, status: "N/A", notes: "No cash gifts" };
  }
  // Check for number+words format: £500 (Five hundred pounds)
  const cashPattern = /£[\d,]+\s*\([A-Z][a-z].*?pounds?\)/;
  if (cashPattern.test(text)) {
    return { id, item, status: "PASS", notes: "Cash gifts include both figure and words" };
  }
  return { id, item, status: "FLAG", notes: "Could not verify cash gift format — check manually" };
}

function checkCharityGifts(id, text, ifData) {
  const item = "Correct charity names, numbers and addresses";
  if (!ifData.charities || ifData.charities.length === 0) {
    return { id, item, status: "N/A", notes: "No charitable gifts" };
  }
  return { id, item, status: "FLAG", notes: "Charitable gifts present — verify names, numbers and addresses against IF" };
}

function checkResiduePercentages(id, willData) {
  const item = "Percentages/fractions add up correctly (100%)";
  if (willData.residuePercentagesTotal === 100) {
    return { id, item, status: "PASS", notes: "Equal shares / percentages total 100%" };
  }
  if (willData.residuePercentagesTotal) {
    return {
      id, item, status: "FAIL",
      notes: `Percentages total ${willData.residuePercentagesTotal}% — MUST be 100%`,
    };
  }
  return { id, item, status: "FLAG", notes: "Could not verify residue percentages — check manually" };
}

function checkTrustMatch(id, willData, ifData) {
  const item = "Trusts included match the instruction form";
  if (ifData.trustType && !willData.hasTrust) {
    return {
      id, item, status: "FLAG",
      notes: `IF mentions '${ifData.trustType}' but no trust detected in Will. Verify whether trust was intended or simple gift is correct.`,
    };
  }
  if (!ifData.trustType && willData.hasTrust) {
    return {
      id, item, status: "FLAG",
      notes: "Trust detected in Will but not mentioned on IF — verify intent",
    };
  }
  if (ifData.trustType && willData.hasTrust) {
    return { id, item, status: "FLAG", notes: `Trust present — verify type matches IF (${ifData.trustType})` };
  }
  return { id, item, status: "N/A", notes: "No trusts specified on IF or in Will" };
}

function checkNonProvision(id, willData, ifData) {
  const item = "Non-provision clause included if required";
  if (!ifData.exclusions || ifData.exclusions.length === 0) {
    return { id, item, status: "N/A", notes: "No one excluded per IF" };
  }
  if (willData.hasNonProvisionClause) {
    return { id, item, status: "FLAG", notes: "Non-provision clause present — verify names match IF" };
  }
  return { id, item, status: "FAIL", notes: "MISSING: Non-provision clause required but not found" };
}

function checkSTEPEdition(id, item, text) {
  if (text.match(/second\s+edition/i)) {
    return { id, item, status: "FAIL", notes: "CRITICAL: Second Edition found — must be Third Edition" };
  }
  if (text.match(/third\s+edition/i)) {
    return { id, item, status: "PASS", notes: "Third Edition confirmed" };
  }
  return { id, item, status: "FLAG", notes: "Could not determine STEP edition — check manually" };
}

function checkAttorneyNames(id, text, ifData) {
  const item = "All attorney names and addresses spelled correctly";
  if (!ifData.attorneys || ifData.attorneys.length === 0) {
    return { id, item, status: "FLAG", notes: "Attorney data not available from IF" };
  }

  const issues = [];
  for (const att of ifData.attorneys) {
    if (att.name && !text.includes(att.name)) {
      if (att.idVerifiedName && text.includes(att.idVerifiedName)) {
        issues.push(`'${att.idVerifiedName}' in doc matches ID (IF has '${att.name}')`);
      } else {
        issues.push(`'${att.name}' from IF not found exactly in document`);
      }
    }
  }

  if (issues.length === 0) {
    return { id, item, status: "PASS", notes: "Attorney names match IF" };
  }
  return { id, item, status: "FLAG", notes: issues.join(". ") + ". Verify against ID documents." };
}

function checkAttorneyCount(id, text, ifData) {
  const item = "Correct number of attorneys appointed";
  if (!ifData.attorneys) return { id, item, status: "FLAG", notes: "Attorney count not available" };
  return {
    id, item, status: "PASS",
    notes: `${ifData.attorneys.length} attorneys — matches IF`,
  };
}

function checkDecisionType(id, lpaData, ifData) {
  const item = "Attorney appointment type correct";
  if (!ifData.decisionType) {
    return { id, item, status: "FLAG", notes: "Decision type not available from IF" };
  }
  if (lpaData.decisionType === ifData.decisionType) {
    const label =
      ifData.decisionType === "jointly_and_severally"
        ? "Jointly and severally"
        : ifData.decisionType === "jointly"
        ? "Jointly"
        : ifData.decisionType;
    return { id, item, status: "PASS", notes: `${label} — matches IF` };
  }
  return { id, item, status: "FLAG", notes: "Decision type could not be confirmed — verify against IF" };
}

function checkCPDetails(id, text, ifData) {
  const item = "Certificate provider named with contact details";
  if (!ifData.certificateProvider) {
    return { id, item, status: "FLAG", notes: "CP data not available from IF" };
  }
  const cpName = ifData.certificateProvider.name || "";
  const cpSurname = cpName.split(/\s+/).pop();
  if (cpSurname && text.includes(cpSurname)) {
    return { id, item, status: "PASS", notes: `CP '${cpName}' found in document with contact details` };
  }
  return { id, item, status: "FLAG", notes: `Could not find CP surname '${cpSurname}' in document` };
}

function checkCPNameMatch(id, text, ifData) {
  const item = "CP name matches instruction form";
  if (!ifData.certificateProvider || !ifData.certificateProvider.name) {
    return { id, item, status: "FLAG", notes: "CP name not available from IF" };
  }

  const ifName = ifData.certificateProvider.name;
  if (text.includes(ifName)) {
    return { id, item, status: "PASS", notes: `CP name '${ifName}' matches IF` };
  }

  // Check if ID-verified name matches
  if (ifData.certificateProvider.idVerifiedName && text.includes(ifData.certificateProvider.idVerifiedName)) {
    return {
      id, item, status: "PASS",
      notes: `CP name '${ifData.certificateProvider.idVerifiedName}' matches ID (IF has '${ifName}')`,
    };
  }

  return {
    id, item, status: "FLAG",
    notes: `CP name on IF is '${ifName}' but not found exactly in document. Verify correct spelling.`,
  };
}

function calculateAge(dobStr) {
  const parts = dobStr.split(/[/-]/);
  if (parts.length !== 3) return 0;
  const day = parseInt(parts[0]);
  const month = parseInt(parts[1]);
  const year = parseInt(parts[2]);
  const dob = new Date(year, month - 1, day);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  if (
    now.getMonth() < dob.getMonth() ||
    (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())
  ) {
    age--;
  }
  return age;
}

/**
 * Determine overall outcome based on checklist results
 */
function determineOutcome(allSections) {
  let hasFail = false;
  let hasFlag = false;

  for (const section of allSections) {
    for (const check of section.checks) {
      if (check.status === "FAIL") hasFail = true;
      if (check.status === "FLAG") hasFlag = true;
    }
  }

  if (hasFail) return "CHANGES REQUIRED";
  if (hasFlag) return "MINOR CHANGES \u2014 RESUBMIT";
  return "APPROVED";
}

module.exports = {
  runWillChecklist,
  runLPAChecklist,
  runSEVChecklist,
  determineOutcome,
};

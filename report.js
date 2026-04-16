/**
 * DOCX Report Generator
 * Generates a proofreading checklist report from results data
 */

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, BorderStyle, WidthType,
  ShadingType, PageBreak, PageNumber,
} = require("docx");

const COLORS = {
  PASS: "2E7D32",
  FAIL: "C62828",
  FLAG: "F57F17",
  "N/A": "757575",
  headerBg: "1A3A5C",
  headerText: "FFFFFF",
  lightBg: "F5F5F5",
  border: "BDBDBD",
};

const border = { style: BorderStyle.SINGLE, size: 1, color: COLORS.border };
const borders = { top: border, bottom: border, left: border, right: border };
const cellMargins = { top: 60, bottom: 60, left: 100, right: 100 };

function statusColor(status) {
  return COLORS[status] || COLORS["N/A"];
}

function statusRun(status) {
  return new TextRun({
    text: status,
    bold: true,
    color: statusColor(status),
    font: "Arial",
    size: 20,
  });
}

/**
 * Generate a DOCX report buffer from results data
 */
async function generateReport(data) {
  const children = [];
  const c = data.consultation;

  // Title
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [
        new TextRun({
          text: "PROOFREADING REVIEW REPORT",
          bold: true,
          font: "Arial",
          size: 36,
          color: COLORS.headerBg,
        }),
      ],
    })
  );

  // Consultation info table
  children.push(
    new Paragraph({
      spacing: { before: 200, after: 100 },
      children: [
        new TextRun({
          text: "Consultation Details",
          bold: true,
          font: "Arial",
          size: 26,
          color: COLORS.headerBg,
        }),
      ],
    })
  );

  const infoRows = [
    ["Reference", c.reference],
    ["Client(s)", c.clientNames.join(", ")],
    ["Address", c.address || ""],
    ["Consultation Type", (c.consultationType || "single").toUpperCase()],
    ["Review Date", c.reviewDate],
    ["Reviewed By", c.reviewer || "Proofreading Tool"],
  ];

  children.push(
    new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [3000, 6360],
      rows: infoRows.map(
        (row) =>
          new TableRow({
            children: [
              new TableCell({
                borders,
                width: { size: 3000, type: WidthType.DXA },
                margins: cellMargins,
                shading: { fill: COLORS.lightBg, type: ShadingType.CLEAR },
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({ text: row[0], bold: true, font: "Arial", size: 20 }),
                    ],
                  }),
                ],
              }),
              new TableCell({
                borders,
                width: { size: 6360, type: WidthType.DXA },
                margins: cellMargins,
                children: [
                  new Paragraph({
                    children: [new TextRun({ text: row[1], font: "Arial", size: 20 })],
                  }),
                ],
              }),
            ],
          })
      ),
    })
  );

  // Overall outcome
  const outcomeColor =
    data.overallOutcome === "APPROVED"
      ? COLORS.PASS
      : data.overallOutcome.includes("CHANGES REQUIRED")
      ? COLORS.FAIL
      : COLORS.FLAG;

  children.push(
    new Paragraph({
      spacing: { before: 300, after: 100 },
      children: [
        new TextRun({
          text: "Overall Outcome: ",
          bold: true,
          font: "Arial",
          size: 26,
          color: COLORS.headerBg,
        }),
        new TextRun({
          text: data.overallOutcome,
          bold: true,
          font: "Arial",
          size: 26,
          color: outcomeColor,
        }),
      ],
    })
  );

  if (data.summary) {
    children.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [new TextRun({ text: data.summary, font: "Arial", size: 22 })],
      })
    );
  }

  // Per-document sections
  for (const doc of data.documents) {
    children.push(new Paragraph({ children: [new PageBreak()] }));

    children.push(
      new Paragraph({
        spacing: { before: 100, after: 60 },
        children: [
          new TextRun({
            text: `${doc.type}: ${doc.name}`,
            bold: true,
            font: "Arial",
            size: 28,
            color: COLORS.headerBg,
          }),
        ],
      })
    );

    children.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({ text: "File: ", bold: true, font: "Arial", size: 18, color: "666666" }),
          new TextRun({ text: doc.filename || "N/A", font: "Arial", size: 18, color: "666666" }),
        ],
      })
    );

    const docOutcomeColor =
      doc.outcome === "APPROVED"
        ? COLORS.PASS
        : doc.outcome.includes("CHANGES REQUIRED")
        ? COLORS.FAIL
        : COLORS.FLAG;

    children.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: "Document Outcome: ", bold: true, font: "Arial", size: 22 }),
          new TextRun({ text: doc.outcome, bold: true, font: "Arial", size: 22, color: docOutcomeColor }),
        ],
      })
    );

    for (const section of doc.sections) {
      children.push(
        new Paragraph({
          spacing: { before: 200, after: 100 },
          children: [
            new TextRun({
              text: section.title,
              bold: true,
              font: "Arial",
              size: 22,
              color: COLORS.headerBg,
            }),
          ],
        })
      );

      const headerRow = new TableRow({
        children: ["#", "Check Item", "Status", "Notes"].map((h, i) => {
          const widths = [600, 4260, 1000, 3500];
          return new TableCell({
            borders,
            width: { size: widths[i], type: WidthType.DXA },
            margins: cellMargins,
            shading: { fill: COLORS.headerBg, type: ShadingType.CLEAR },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: h,
                    bold: true,
                    font: "Arial",
                    size: 18,
                    color: COLORS.headerText,
                  }),
                ],
              }),
            ],
          });
        }),
      });

      const checkRows = section.checks.map((check, idx) => {
        const widths = [600, 4260, 1000, 3500];
        const bgFill = idx % 2 === 0 ? "FFFFFF" : COLORS.lightBg;
        return new TableRow({
          children: [
            new TableCell({
              borders,
              width: { size: widths[0], type: WidthType.DXA },
              margins: cellMargins,
              shading: { fill: bgFill, type: ShadingType.CLEAR },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: check.id, font: "Arial", size: 18 })],
                }),
              ],
            }),
            new TableCell({
              borders,
              width: { size: widths[1], type: WidthType.DXA },
              margins: cellMargins,
              shading: { fill: bgFill, type: ShadingType.CLEAR },
              children: [
                new Paragraph({
                  children: [new TextRun({ text: check.item, font: "Arial", size: 18 })],
                }),
              ],
            }),
            new TableCell({
              borders,
              width: { size: widths[2], type: WidthType.DXA },
              margins: cellMargins,
              shading: { fill: bgFill, type: ShadingType.CLEAR },
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [statusRun(check.status)],
                }),
              ],
            }),
            new TableCell({
              borders,
              width: { size: widths[3], type: WidthType.DXA },
              margins: cellMargins,
              shading: { fill: bgFill, type: ShadingType.CLEAR },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: check.notes || "",
                      font: "Arial",
                      size: 18,
                      italics: !!check.notes,
                    }),
                  ],
                }),
              ],
            }),
          ],
        });
      });

      children.push(
        new Table({
          width: { size: 9360, type: WidthType.DXA },
          columnWidths: [600, 4260, 1000, 3500],
          rows: [headerRow, ...checkRows],
        })
      );
    }
  }

  // Recommended Actions
  if (data.recommendedActions && data.recommendedActions.length > 0) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(
      new Paragraph({
        spacing: { before: 100, after: 200 },
        children: [
          new TextRun({
            text: "Recommended Actions",
            bold: true,
            font: "Arial",
            size: 28,
            color: COLORS.headerBg,
          }),
        ],
      })
    );

    for (const action of data.recommendedActions) {
      children.push(
        new Paragraph({
          spacing: { after: 100 },
          children: [
            new TextRun({ text: `${action.document}: `, bold: true, font: "Arial", size: 20 }),
            new TextRun({ text: action.action, font: "Arial", size: 20 }),
          ],
        })
      );
      if (action.hubspotNote) {
        children.push(
          new Paragraph({
            spacing: { after: 150 },
            children: [
              new TextRun({
                text: "Suggested HubSpot note: ",
                bold: true,
                font: "Arial",
                size: 18,
                color: "666666",
              }),
              new TextRun({
                text: `"${action.hubspotNote}"`,
                italics: true,
                font: "Arial",
                size: 18,
                color: "666666",
              }),
            ],
          })
        );
      }
    }
  }

  // Build document
  const doc = new Document({
    styles: {
      default: { document: { run: { font: "Arial", size: 22 } } },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1440, right: 1080, bottom: 1440, left: 1080 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: `Proofreading Report | ${c.reference}`,
                    font: "Arial",
                    size: 16,
                    color: "999999",
                  }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: "Page ", font: "Arial", size: 16, color: "999999" }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: "Arial",
                    size: 16,
                    color: "999999",
                  }),
                  new TextRun({
                    text: " | Generated by Proofreading Tool | Octopus Legacy",
                    font: "Arial",
                    size: 16,
                    color: "999999",
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

module.exports = { generateReport };

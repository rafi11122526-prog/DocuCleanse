import JSZip from 'jszip';

export interface DashboardChartSeriesItem {
  label: string;
  volume: number;
  count: number;
}

export interface DashboardChartsConfig {
  sheetName: string;
  firstDataRow: number; // 1-based Excel row number of first currency row (e.g., 12)
  lastDataRow: number; // 1-based Excel row number of last currency row (e.g., 14)
  labelColLetter: string; // e.g., 'B'
  volumeColLetter: string; // e.g., 'C'
  countColLetter: string; // e.g., 'D'
  anchorStartRowZeroBased: number; // 0-based row where charts start (e.g., 16)
  anchorEndRowZeroBased: number; // 0-based row where charts end (e.g., 32)
  barTitle: string;
  donutTitle: string;
  items: DashboardChartSeriesItem[];
}

const SERIES_PALETTE = ['2563EB', '10B981', 'F59E0B', '6366F1', '0EA5E9', 'EC4899', '14B8A6', '8B5CF6'];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildChartTitleXml(titleText: string): string {
  return `<c:title>
      <c:tx>
        <c:rich>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p>
            <a:pPr>
              <a:defRPr sz="1200" b="1">
                <a:solidFill><a:srgbClr val="0F172A"/></a:solidFill>
                <a:latin typeface="Segoe UI"/>
              </a:defRPr>
            </a:pPr>
            <a:r>
              <a:rPr lang="en-US" sz="1200" b="1">
                <a:solidFill><a:srgbClr val="0F172A"/></a:solidFill>
                <a:latin typeface="Segoe UI"/>
              </a:rPr>
              <a:t>${escapeXml(titleText)}</a:t>
            </a:r>
          </a:p>
        </c:rich>
      </c:tx>
      <c:overlay val="0"/>
    </c:title>`;
}

function buildStrCacheXml(items: DashboardChartSeriesItem[]): string {
  const pts = items
    .map((item, idx) => `<c:pt idx="${idx}"><c:v>${escapeXml(item.label)}</c:v></c:pt>`)
    .join('');
  return `<c:strCache><c:ptCount val="${items.length}"/>${pts}</c:strCache>`;
}

function buildNumCacheXml(values: number[], formatCode: string): string {
  const pts = values
    .map((val, idx) => `<c:pt idx="${idx}"><c:v>${Number.isFinite(val) ? val : 0}</c:v></c:pt>`)
    .join('');
  return `<c:numCache><c:formatCode>${escapeXml(formatCode)}</c:formatCode><c:ptCount val="${values.length}"/>${pts}</c:numCache>`;
}

function formatChartSheetRef(sheetName: string): string {
  const safeName = sheetName.replace(/'/g, "''");
  return /^[A-Za-z0-9_]+$/.test(safeName) ? safeName : `'${safeName}'`;
}

function buildBarChartXml(cfg: DashboardChartsConfig): string {
  const sheetRef = formatChartSheetRef(cfg.sheetName);
  const catFormula = `${sheetRef}!$${cfg.labelColLetter}$${cfg.firstDataRow}:$${cfg.labelColLetter}$${cfg.lastDataRow}`;
  const valFormula = `${sheetRef}!$${cfg.volumeColLetter}$${cfg.firstDataRow}:$${cfg.volumeColLetter}$${cfg.lastDataRow}`;

  const dataPointsXml = cfg.items
    .map((_, idx) => {
      const color = SERIES_PALETTE[idx % SERIES_PALETTE.length];
      return `<c:dPt><c:idx val="${idx}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:dPt>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:date1904 val="0"/>
  <c:lang val="en-US"/>
  <c:roundedCorners val="0"/>
  <c:chart>
    ${buildChartTitleXml(cfg.barTitle)}
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:layout/>
      <c:barChart>
        <c:barDir val="col"/>
        <c:grouping val="clustered"/>
        <c:varyColors val="1"/>
        <c:ser>
          <c:idx val="0"/>
          <c:order val="0"/>
          <c:tx><c:v>Gross Volume</c:v></c:tx>
          <c:invertIfNegative val="0"/>
          ${dataPointsXml}
          <c:dLbls>
            <c:numFmt formatCode="#,##0.00" sourceLinked="0"/>
            <c:txPr>
              <a:bodyPr/>
              <a:lstStyle/>
              <a:p>
                <a:pPr>
                  <a:defRPr sz="900" b="1">
                    <a:solidFill><a:srgbClr val="1E293B"/></a:solidFill>
                    <a:latin typeface="Segoe UI"/>
                  </a:defRPr>
                </a:pPr>
                <a:endParaRPr lang="en-US"/>
              </a:p>
            </c:txPr>
            <c:showLegendKey val="0"/>
            <c:showVal val="1"/>
            <c:showCatName val="0"/>
            <c:showSerName val="0"/>
            <c:showPercent val="0"/>
            <c:showBubbleSize val="0"/>
          </c:dLbls>
          <c:cat>
            <c:strRef>
              <c:f>${catFormula}</c:f>
              ${buildStrCacheXml(cfg.items)}
            </c:strRef>
          </c:cat>
          <c:val>
            <c:numRef>
              <c:f>${valFormula}</c:f>
              ${buildNumCacheXml(cfg.items.map((i) => i.volume), '#,##0.00')}
            </c:numRef>
          </c:val>
        </c:ser>
        <c:gapWidth val="80"/>
        <c:axId val="1001"/>
        <c:axId val="1002"/>
      </c:barChart>
      <c:catAx>
        <c:axId val="1001"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="b"/>
        <c:majorTickMark val="none"/>
        <c:minorTickMark val="none"/>
        <c:tickLblPos val="nextTo"/>
        <c:spPr>
          <a:ln w="9525"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:ln>
        </c:spPr>
        <c:txPr>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p>
            <a:pPr>
              <a:defRPr sz="950" b="1">
                <a:solidFill><a:srgbClr val="334155"/></a:solidFill>
                <a:latin typeface="Segoe UI"/>
              </a:defRPr>
            </a:pPr>
            <a:endParaRPr lang="en-US"/>
          </a:p>
        </c:txPr>
        <c:crossAx val="1002"/>
        <c:crosses val="autoZero"/>
        <c:auto val="1"/>
        <c:lblAlgn val="ctr"/>
        <c:lblOffset val="100"/>
      </c:catAx>
      <c:valAx>
        <c:axId val="1002"/>
        <c:scaling><c:orientation val="minMax"/></c:scaling>
        <c:delete val="0"/>
        <c:axPos val="l"/>
        <c:majorGridlines>
          <c:spPr>
            <a:ln w="6350"><a:solidFill><a:srgbClr val="E2E8F0"/></a:solidFill></a:ln>
          </c:spPr>
        </c:majorGridlines>
        <c:numFmt formatCode="#,##0" sourceLinked="0"/>
        <c:majorTickMark val="none"/>
        <c:minorTickMark val="none"/>
        <c:tickLblPos val="nextTo"/>
        <c:spPr>
          <a:ln><a:noFill/></a:ln>
        </c:spPr>
        <c:txPr>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p>
            <a:pPr>
              <a:defRPr sz="900">
                <a:solidFill><a:srgbClr val="64748B"/></a:solidFill>
                <a:latin typeface="Segoe UI"/>
              </a:defRPr>
            </a:pPr>
            <a:endParaRPr lang="en-US"/>
          </a:p>
        </c:txPr>
        <c:crossAx val="1001"/>
        <c:crosses val="autoZero"/>
        <c:crossBetween val="between"/>
      </c:valAx>
      <c:spPr>
        <a:noFill/>
        <a:ln><a:noFill/></a:ln>
      </c:spPr>
    </c:plotArea>
    <c:plotVisOnly val="1"/>
    <c:dispBlanksAs val="gap"/>
  </c:chart>
  <c:spPr>
    <a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>
    <a:ln w="9525"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:ln>
  </c:spPr>
</c:chartSpace>`;
}

function buildDoughnutChartXml(cfg: DashboardChartsConfig): string {
  const sheetRef = formatChartSheetRef(cfg.sheetName);
  const catFormula = `${sheetRef}!$${cfg.labelColLetter}$${cfg.firstDataRow}:$${cfg.labelColLetter}$${cfg.lastDataRow}`;
  const valFormula = `${sheetRef}!$${cfg.countColLetter}$${cfg.firstDataRow}:$${cfg.countColLetter}$${cfg.lastDataRow}`;

  const dataPointsXml = cfg.items
    .map((_, idx) => {
      const color = SERIES_PALETTE[idx % SERIES_PALETTE.length];
      return `<c:dPt><c:idx val="${idx}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln w="19050"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:date1904 val="0"/>
  <c:lang val="en-US"/>
  <c:roundedCorners val="0"/>
  <c:chart>
    ${buildChartTitleXml(cfg.donutTitle)}
    <c:autoTitleDeleted val="0"/>
    <c:plotArea>
      <c:layout/>
      <c:doughnutChart>
        <c:varyColors val="1"/>
        <c:ser>
          <c:idx val="0"/>
          <c:order val="0"/>
          <c:tx><c:v>Transactions</c:v></c:tx>
          ${dataPointsXml}
          <c:dLbls>
            <c:txPr>
              <a:bodyPr/>
              <a:lstStyle/>
              <a:p>
                <a:pPr>
                  <a:defRPr sz="900" b="1">
                    <a:solidFill><a:srgbClr val="0F172A"/></a:solidFill>
                    <a:latin typeface="Segoe UI"/>
                  </a:defRPr>
                </a:pPr>
                <a:endParaRPr lang="en-US"/>
              </a:p>
            </c:txPr>
            <c:showLegendKey val="0"/>
            <c:showVal val="1"/>
            <c:showCatName val="0"/>
            <c:showSerName val="0"/>
            <c:showPercent val="1"/>
            <c:showBubbleSize val="0"/>
          </c:dLbls>
          <c:cat>
            <c:strRef>
              <c:f>${catFormula}</c:f>
              ${buildStrCacheXml(cfg.items)}
            </c:strRef>
          </c:cat>
          <c:val>
            <c:numRef>
              <c:f>${valFormula}</c:f>
              ${buildNumCacheXml(cfg.items.map((i) => i.count), '#,##0')}
            </c:numRef>
          </c:val>
        </c:ser>
        <c:firstSliceAng val="0"/>
        <c:holeSize val="54"/>
      </c:doughnutChart>
      <c:spPr>
        <a:noFill/>
        <a:ln><a:noFill/></a:ln>
      </c:spPr>
    </c:plotArea>
    <c:legend>
      <c:legendPos val="b"/>
      <c:overlay val="0"/>
      <c:txPr>
        <a:bodyPr/>
        <a:lstStyle/>
        <a:p>
          <a:pPr>
            <a:defRPr sz="950">
              <a:solidFill><a:srgbClr val="334155"/></a:solidFill>
              <a:latin typeface="Segoe UI"/>
            </a:defRPr>
          </a:pPr>
          <a:endParaRPr lang="en-US"/>
        </a:p>
      </c:txPr>
    </c:legend>
    <c:plotVisOnly val="1"/>
    <c:dispBlanksAs val="gap"/>
  </c:chart>
  <c:spPr>
    <a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>
    <a:ln w="9525"><a:solidFill><a:srgbClr val="CBD5E1"/></a:solidFill></a:ln>
  </c:spPr>
</c:chartSpace>`;
}

function buildDrawingXml(cfg: DashboardChartsConfig): string {
  const r1 = cfg.anchorStartRowZeroBased;
  const r2 = cfg.anchorEndRowZeroBased;
  // Left chart: columns B (1) -> E (5) exclusive, Right chart: columns F (5) -> I (9) exclusive
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <xdr:twoCellAnchor>
    <xdr:from>
      <xdr:col>1</xdr:col>
      <xdr:colOff>0</xdr:colOff>
      <xdr:row>${r1}</xdr:row>
      <xdr:rowOff>0</xdr:rowOff>
    </xdr:from>
    <xdr:to>
      <xdr:col>5</xdr:col>
      <xdr:colOff>-114300</xdr:colOff>
      <xdr:row>${r2}</xdr:row>
      <xdr:rowOff>0</xdr:rowOff>
    </xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="2" name="Gross Volume by Currency Chart"/>
        <xdr:cNvGraphicFramePr/>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm>
        <a:off x="0" y="0"/>
        <a:ext cx="0" cy="0"/>
      </xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>
        </a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
  <xdr:twoCellAnchor>
    <xdr:from>
      <xdr:col>5</xdr:col>
      <xdr:colOff>114300</xdr:colOff>
      <xdr:row>${r1}</xdr:row>
      <xdr:rowOff>0</xdr:rowOff>
    </xdr:from>
    <xdr:to>
      <xdr:col>9</xdr:col>
      <xdr:colOff>0</xdr:colOff>
      <xdr:row>${r2}</xdr:row>
      <xdr:rowOff>0</xdr:rowOff>
    </xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="3" name="Transaction Count by Currency Chart"/>
        <xdr:cNvGraphicFramePr/>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm>
        <a:off x="0" y="0"/>
        <a:ext cx="0" cy="0"/>
      </xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId2"/>
        </a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>
</xdr:wsDr>`;
}

/**
 * Injects two ECMA-376 spec-compliant native Excel OOXML charts (Bar Chart + Doughnut Chart)
 * onto Tab 1 (sheet1.xml — Executive_Dashboard) of an ExcelJS-generated XLSX archive.
 */
export async function injectNativeDashboardCharts(
  xlsxBuffer: Buffer,
  cfg: DashboardChartsConfig
): Promise<Buffer> {
  if (cfg.items.length === 0) return xlsxBuffer;

  const zip = await JSZip.loadAsync(xlsxBuffer);

  // 1. Add native Chart XML parts & Drawing part
  zip.file('xl/charts/chart1.xml', buildBarChartXml(cfg));
  zip.file('xl/charts/chart2.xml', buildDoughnutChartXml(cfg));
  zip.file('xl/drawings/drawing1.xml', buildDrawingXml(cfg));
  zip.file(
    'xl/drawings/_rels/drawing1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart2.xml"/>
</Relationships>`
  );

  // 2. Link drawing1.xml from sheet1.xml.rels (Executive_Dashboard is Tab 1 -> sheet1.xml)
  const drawingRelId = 'rIdChartDrawing1';
  const drawingRelTag = `<Relationship Id="${drawingRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>`;
  const existingSheetRels = zip.file('xl/worksheets/_rels/sheet1.xml.rels');
  if (existingSheetRels) {
    let relsXml = await existingSheetRels.async('string');
    if (!relsXml.includes('../drawings/drawing1.xml')) {
      relsXml = relsXml.replace('</Relationships>', `${drawingRelTag}</Relationships>`);
      zip.file('xl/worksheets/_rels/sheet1.xml.rels', relsXml);
    }
  } else {
    zip.file(
      'xl/worksheets/_rels/sheet1.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRelTag}</Relationships>`
    );
  }

  // 3. Reference <drawing r:id="rIdChartDrawing1"/> in xl/worksheets/sheet1.xml per ECMA-376 order
  const sheet1File = zip.file('xl/worksheets/sheet1.xml');
  if (sheet1File) {
    let sheet1Xml = await sheet1File.async('string');
    if (!sheet1Xml.includes('xmlns:r=')) {
      sheet1Xml = sheet1Xml.replace(
        '<worksheet ',
        '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      );
    }
    if (!sheet1Xml.includes(`r:id="${drawingRelId}"`)) {
      const drawingTag = `<drawing r:id="${drawingRelId}"/>`;
      if (sheet1Xml.includes('<extLst')) {
        sheet1Xml = sheet1Xml.replace('<extLst', `${drawingTag}<extLst`);
      } else {
        sheet1Xml = sheet1Xml.replace('</worksheet>', `${drawingTag}</worksheet>`);
      }
      zip.file('xl/worksheets/sheet1.xml', sheet1Xml);
    }
  }

  // 4. Register Drawing & Chart MIME content types in [Content_Types].xml
  const contentTypesFile = zip.file('[Content_Types].xml');
  if (contentTypesFile) {
    let ctXml = await contentTypesFile.async('string');
    const overrides = [
      {
        part: '/xl/drawings/drawing1.xml',
        type: 'application/vnd.openxmlformats-officedocument.drawing+xml',
      },
      {
        part: '/xl/charts/chart1.xml',
        type: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
      },
      {
        part: '/xl/charts/chart2.xml',
        type: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
      },
    ];
    let additions = '';
    for (const o of overrides) {
      if (!ctXml.includes(o.part)) {
        additions += `<Override PartName="${o.part}" ContentType="${o.type}"/>`;
      }
    }
    if (additions) {
      ctXml = ctXml.replace('</Types>', `${additions}</Types>`);
      zip.file('[Content_Types].xml', ctXml);
    }
  }

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

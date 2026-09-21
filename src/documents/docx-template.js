import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { formatPersonDisplayName } from '../utils/person-name.js';

export const HANDOVER_IT_OPERATORS = {
  'Andrei Popescu': {
    introName: 'Popescu Andrei',
    signatureName: 'Popescu Andrei',
    role: 'Engineer IT'
  },
  'Dan Istrate': {
    introName: 'Istrate Dan',
    signatureName: 'Istrate Dan',
    role: 'Engineer IT Lead RO & BG'
  }
};

const COMPANY_NAME = 'Tchibo Brands Romania';
const LEGAL_ENTITY = 'Tchibo Brands SRL';

export async function renderHandoverDocx(document, templatePath = '') {
  const values = handoverValues(document);
  let files = defaultDocxFiles(buildTchiboDocumentXml(values));

  if (templatePath) {
    try {
      files = readDocxFiles(await readFile(templatePath));
      const documentXml = files.get('word/document.xml')?.toString('utf8');
      if (documentXml) {
        files.set('word/document.xml', Buffer.from(applyTemplatePlaceholders(documentXml, values), 'utf8'));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  return buildZip(files);
}

export function handoverValues(document) {
  const person = document.person || {};
  const personName = formatPersonDisplayName(person);
  const personRole = person.role || person.department || '-';
  const itMeta = HANDOVER_IT_OPERATORS[document.itOperator] || {
    introName: document.itOperator || '-',
    signatureName: document.itOperator || '-',
    role: 'Engineer IT'
  };
  const dateFormatted = formatRoDate(document.date);
  const rows = buildAssetRows(document.assets || [], document.notes);
  const isPredare = document.type === 'predare';

  const introParagraph = isPredare
    ? `Incheiat intre ${LEGAL_ENTITY}, reprezentat prin ${itMeta.introName} avand functia de ${itMeta.role} in departamentul IT si ${personName} avand functia de ${personRole} s-au returnat urmatoarele:`
    : `Incheiat intre ${LEGAL_ENTITY}, reprezentat prin ${itMeta.introName} avand functia de ${itMeta.role} in departamentul IT si ${personName} avand functia de ${personRole} s-au predat urmatoarele:`;

  const predatName = isPredare ? personName : itMeta.signatureName;
  const primitName = isPredare ? itMeta.signatureName : personName;

  return {
    companyName: COMPANY_NAME,
    title: 'PROCES VERBAL de predare – primire',
    date: document.date || '',
    dateFormatted,
    dateLine: `Incheiat astazi ${dateFormatted}`,
    introParagraph,
    itOperator: document.itOperator || '',
    itOperatorIntro: itMeta.introName,
    itOperatorRole: itMeta.role,
    itOperatorSignature: itMeta.signatureName,
    personName,
    personRole,
    personSignature: personName,
    predatName,
    primitName,
    notes: document.notes || '',
    assetsTableXml: buildAssetsTableXml(rows),
    assetsText: rows.map((row, index) =>
      `${index + 1}. ${row.tip} | ${row.model} | ${row.imei} | ${row.serial}`
    ).join('\n')
  };
}

export function buildAssetRows(assets, notes = '') {
  const rows = (assets || []).map(handoverAssetRow);
  for (const line of String(notes || '').split('\n').map((item) => item.trim()).filter(Boolean)) {
    if (line.includes('|')) {
      const [tip, model = '', imei = '', serial = ''] = line.split('|').map((part) => part.trim());
      rows.push({ tip, model, imei, serial });
    } else {
      rows.push({ tip: line, model: '', imei: '', serial: '' });
    }
  }
  return rows;
}

function handoverAssetRow(asset) {
  const isPhone = asset.category?.name === 'Telefon' || asset.model?.deviceType === 'Telefon';
  if (isPhone) {
    return {
      tip: 'Telefon',
      model: formatHandoverModel(asset),
      imei: asset.imei || asset.assetTag || '',
      serial: asset.serialNumber || ''
    };
  }
  return {
    tip: 'Laptop + Incarcator + mouse',
    model: formatHandoverModel(asset),
    imei: asset.assetTag || '',
    serial: asset.serialNumber || ''
  };
}

function formatHandoverModel(asset) {
  const brand = asset.brand?.name || '';
  const name = asset.model?.name || '';
  const generation = asset.model?.generation || '';
  if (brand.includes('MacBook')) return [name, generation].filter(Boolean).join(' ').trim();
  if (brand.includes('Lenovo') || name.includes('ThinkPad')) {
    const gen = generation.replace(/^Gen\s*/i, 'G');
    return [name.replace(/^ThinkPad\s*/i, ''), gen ? `G${gen.replace(/^G/, '')}` : '']
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim() || name;
  }
  if (name.startsWith('iPhone')) return name;
  return [brand, name, generation].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function buildTchiboDocumentXml(values) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraph(values.companyName, { align: 'center', size: 24, after: 120 })}
    ${paragraph('PROCES VERBAL', { align: 'center', bold: true, size: 40, after: 40 })}
    ${paragraph('de predare – primire', { align: 'center', bold: true, size: 26, after: 120 })}
    ${paragraph(values.dateLine, { align: 'center', size: 24, after: 180 })}
    ${introParagraphXml(values.introParagraph, values)}
    ${paragraph('', { after: 120 })}
    ${values.assetsTableXml}
    ${paragraph('', { after: 200 })}
    ${signatureBlock(values.predatName, values.primitName)}
    ${hrFooterBlock(480)}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:right="1417" w:bottom="1134" w:left="1417"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

function introParagraphXml(introText, values) {
  const parts = [
    { text: 'Incheiat intre ' },
    { text: LEGAL_ENTITY, bold: true },
    { text: ', reprezentat prin ' },
    { text: values.itOperatorIntro, bold: true },
    { text: ' avand functia de ' },
    { text: values.itOperatorRole, bold: true },
    { text: ' in departamentul IT si ' },
    { text: values.personName, bold: true },
    { text: ' avand functia de ' },
    { text: values.personRole, bold: true },
    { text: introText.includes('returnat') ? ' s-au returnat urmatoarele:' : ' s-au predat urmatoarele:' }
  ];
  return mixedParagraph(parts, { justify: true, size: 22 });
}

function buildAssetsTableXml(rows) {
  const headers = ['Tip', 'Model', 'IMEI / UDID / Tel.', 'Serial No.'];
  const bodyRows = rows.length ? rows : [{ tip: '-', model: '-', imei: '-', serial: '-' }];
  const grid = [3000, 2200, 2400, 1760];
  const tblPr = `<w:tblPr>
    <w:tblW w:w="5000" w:type="pct"/>
    <w:jc w:val="center"/>
    <w:tblLayout w:type="fixed"/>
    <w:tblBorders>
      <w:top w:val="single" w:sz="8" w:space="0" w:color="000000"/>
      <w:left w:val="single" w:sz="8" w:space="0" w:color="000000"/>
      <w:bottom w:val="single" w:sz="8" w:space="0" w:color="000000"/>
      <w:right w:val="single" w:sz="8" w:space="0" w:color="000000"/>
      <w:insideH w:val="single" w:sz="8" w:space="0" w:color="000000"/>
      <w:insideV w:val="single" w:sz="8" w:space="0" w:color="000000"/>
    </w:tblBorders>
  </w:tblPr>`;
  const gridXml = `<w:tblGrid>${grid.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`;
  const headerRow = tableRow(headers.map((text) => tableCell(text, { header: true, align: 'center' })));
  const dataRows = bodyRows.map((row) => tableRow([
    tableCell(row.tip),
    tableCell(row.model),
    tableCell(row.imei),
    tableCell(row.serial)
  ]));
  return `<w:tbl>${tblPr}${gridXml}${headerRow}${dataRows.join('')}</w:tbl>`;
}

function signatureBlock(predatName, primitName) {
  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="5000" w:type="pct"/>
      <w:tblLayout w:type="fixed"/>
      <w:tblBorders>
        <w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/>
        <w:insideH w:val="nil"/><w:insideV w:val="nil"/>
      </w:tblBorders>
    </w:tblPr>
    <w:tblGrid><w:gridCol w:w="3200"/><w:gridCol w:w="6160"/></w:tblGrid>
    <w:tr>
      ${signatureCell('Predat,', predatName, 'left')}
      ${signatureCell('Primit,', primitName, 'right')}
    </w:tr>
  </w:tbl>`;
}

function signatureCell(label, name, side = 'left') {
  const isRight = side === 'right';
  const width = isRight ? 6160 : 3200;
  const margins = isRight
    ? `<w:top w:w="0" w:type="dxa"/><w:left w:w="3000" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/>`
    : `<w:top w:w="0" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="120" w:type="dxa"/>`;
  return `<w:tc>
    <w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:tcMar>${margins}</w:tcMar></w:tcPr>
    ${paragraph(label, { bold: true, size: 22 })}
    ${paragraph(name, { bold: true, size: 22, after: 80 })}
    ${signatureLine(isRight)}
  </w:tc>`;
}

function signatureLine(rightSide = false) {
  const indent = rightSide
    ? '<w:ind w:left="0" w:right="120"/>'
    : '<w:ind w:right="480"/>';
  return `<w:p><w:pPr>
    <w:spacing w:before="180" w:after="0"/>
    ${indent}
    <w:pBdr><w:bottom w:val="dotted" w:sz="8" w:space="4" w:color="000000"/></w:pBdr>
  </w:pPr></w:p>`;
}

function hrFooterBlock(beforeSpacing) {
  return `
    ${paragraph('Avizat Departament HR', { align: 'center', bold: true, size: 22, before: beforeSpacing, after: 120 })}
    ${horizontalRule()}
  `;
}

function horizontalRule() {
  return `<w:p><w:pPr>
    <w:jc w:val="center"/>
    <w:ind w:left="2800" w:right="2800"/>
    <w:spacing w:after="0"/>
    <w:pBdr><w:bottom w:val="single" w:sz="12" w:space="1" w:color="000000"/></w:pBdr>
  </w:pPr></w:p>`;
}

function tableRow(cells) {
  return `<w:tr>${cells.join('')}</w:tr>`;
}

function tableCell(text, options = {}) {
  const { header = false, align = 'left', width = 0 } = options;
  const widthXml = width ? `<w:tcW w:w="${width}" w:type="dxa"/>` : '<w:tcW w:w="0" w:type="auto"/>';
  const valign = header ? '<w:vAlign w:val="center"/>' : '';
  const content = String(text ?? '').split('\n').map((line) => paragraph(line, {
    size: 20,
    bold: header,
    align: header ? align : 'left'
  })).join('');
  return `<w:tc><w:tcPr>${widthXml}${valign}</w:tcPr>${content}</w:tc>`;
}

function mixedParagraph(parts, options = {}) {
  const { justify = false, align = 'left', size = 22, after = 0, before = 0 } = options;
  const pPr = [];
  if (justify) pPr.push('<w:jc w:val="both"/>');
  else if (align !== 'left') pPr.push(`<w:jc w:val="${align === 'center' ? 'center' : align}"/>`);
  if (after) pPr.push(`<w:spacing w:after="${after}"/>`);
  if (before) pPr.push(`<w:spacing w:before="${before}"/>`);
  const runs = parts.map((part) => {
    const rPr = [];
    if (part.bold) rPr.push('<w:b/>');
    if (size) rPr.push(`<w:sz w:val="${size}"/>`);
    const rPrXml = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';
    return `<w:r>${rPrXml}<w:t xml:space="preserve">${escapeXml(part.text)}</w:t></w:r>`;
  }).join('');
  const pPrXml = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';
  return `<w:p>${pPrXml}${runs}</w:p>`;
}

function paragraph(text, options = {}) {
  const { bold = false, align = 'left', underline = false, size = 22, after = 0, before = 0 } = options;
  const pPr = [];
  if (align !== 'left') pPr.push(`<w:jc w:val="${align === 'center' ? 'center' : align}"/>`);
  if (after || before) {
    const spacing = [];
    if (before) spacing.push(`w:before="${before}"`);
    if (after) spacing.push(`w:after="${after}"`);
    pPr.push(`<w:spacing ${spacing.join(' ')}/>`);
  }
  const rPr = [];
  if (bold) rPr.push('<w:b/>');
  if (underline) rPr.push('<w:u w:val="single"/>');
  if (size) rPr.push(`<w:sz w:val="${size}"/>`);
  const pPrXml = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';
  const rPrXml = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';
  return `<w:p>${pPrXml}<w:r>${rPrXml}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function applyTemplatePlaceholders(xml, values) {
  let content = xml;
  for (const [key, value] of Object.entries(values)) {
    if (key === 'assetsTableXml') {
      content = content.replaceAll('{{assetsTable}}', value);
    }
    content = content.replaceAll(`{{${key}}}`, escapeXml(typeof value === 'string' ? value : ''));
  }
  return content;
}

function formatRoDate(value) {
  const clean = String(value ?? '').trim();
  const match = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[3]}.${match[2]}.${match[1]}`;
  return clean;
}

const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function defaultDocxFiles(documentXml) {
  return new Map([
    ['[Content_Types].xml', Buffer.from(contentTypesXml, 'utf8')],
    ['_rels/.rels', Buffer.from(relsXml, 'utf8')],
    ['word/document.xml', Buffer.from(documentXml, 'utf8')]
  ]);
}

function readDocxFiles(buffer) {
  const files = new Map();
  const centralDirectory = readCentralDirectory(buffer);
  for (const entry of centralDirectory) {
    files.set(entry.fileName, extractZipEntry(buffer, entry));
  }
  return files;
}

function readCentralDirectory(buffer) {
  const eocdOffset = findSignatureBackwards(buffer, 0x06054b50, buffer.length - 22);
  if (eocdOffset < 0) throw new Error('Template DOCX invalid.');
  const entriesCount = buffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let offset = cdOffset;

  while (offset + 46 <= buffer.length && entries.length < entriesCount) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const fileName = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    entries.push({
      fileName,
      compressionMethod: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      localHeaderOffset: buffer.readUInt32LE(offset + 42)
    });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function extractZipEntry(buffer, entry) {
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error('Template DOCX invalid.');
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.compressionMethod === 0) return Buffer.from(data);
  if (entry.compressionMethod === 8) return inflateRawSync(data);
  throw new Error(`Metoda DOCX ${entry.compressionMethod} nu este suportata.`);
}

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuffer, content);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + content.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.size, 8);
  eocd.writeUInt16LE(files.size, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function findSignatureBackwards(buffer, signature, start) {
  for (let offset = start; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

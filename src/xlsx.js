// Gerador mínimo de planilha Excel (.xlsx), sem dependências pesadas.
// Uma planilha .xlsx é um zip de arquivos XML; aqui montamos só o necessário:
// várias abas, textos, números, datas, fórmulas (com valor já calculado),
// estilos fixos, largura de colunas, linha congelada e filtro.

import { zipSync, strToU8 } from 'fflate';

// Estilos disponíveis (índice em cellXfs, veja ESTILOS_XML)
export const S = {
  normal: 0,
  negrito: 1,
  cabecalho: 2,
  moeda: 3,
  moedaNegrito: 4,
  data: 5,
  porcento: 6,
  titulo: 7,
  totalTexto: 8,
  totalMoeda: 9,
  destaqueTexto: 10,
  destaqueMoeda: 11,
  cabecalhoMoeda: 12,
  sutil: 13,
};

const ESTILOS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
<numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00;[Red]\\-&quot;R$&quot;\\ #,##0.00"/>
<numFmt numFmtId="165" formatCode="dd/mm/yyyy"/>
<numFmt numFmtId="166" formatCode="0.0%"/>
</numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="15"/><color rgb="FF0F766E"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="12"/><name val="Calibri"/><family val="2"/></font>
<font><i/><sz val="10"/><color rgb="FF66736D"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE6F2F0"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFCCEBE7"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FF9FB8B3"/></bottom><diagonal/></border>
<border><left/><right/><top style="thin"><color rgb="FF66736D"/></top><bottom/><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="14">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="3" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // remove caracteres de controle que o Excel não aceita
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Número da coluna (0 = A) para letras. */
export function coluna(n) {
  let s = '';
  n += 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "2026-11-24" -> número de série de data do Excel. */
export function serialData(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  return (Date.UTC(a, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
}

/**
 * Célula pode ser:
 *  null/undefined -> vazia
 *  string | number
 *  { v, s, f }   -> valor, estilo (S.*), fórmula (sem "=")
 */
function celulaXml(ref, c) {
  if (c === null || c === undefined || c === '') return '';
  const cel = typeof c === 'object' ? c : { v: c };
  const s = cel.s ? ` s="${cel.s}"` : '';
  const f = cel.f ? `<f>${esc(cel.f)}</f>` : '';
  const v = cel.v;
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}>${f}<v>${v}</v></c>`;
  if (cel.f) return `<c r="${ref}"${s} t="str">${f}<v>${esc(v ?? '')}</v></c>`;
  if (v === null || v === undefined || v === '') return s ? `<c r="${ref}"${s}/>` : '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

function abaXml({ linhas, larguras = [], congelarLinhas = 0, congelarColunas = 0, filtro }) {
  const cols = larguras.length
    ? `<cols>${larguras.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  let vista = '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  if (congelarLinhas || congelarColunas) {
    const canto = `${coluna(congelarColunas)}${congelarLinhas + 1}`;
    const painel = congelarLinhas && congelarColunas ? 'bottomRight' : congelarLinhas ? 'bottomLeft' : 'topRight';
    vista = `<sheetViews><sheetView workbookViewId="0"><pane${congelarColunas ? ` xSplit="${congelarColunas}"` : ''}${
      congelarLinhas ? ` ySplit="${congelarLinhas}"` : ''
    } topLeftCell="${canto}" activePane="${painel}" state="frozen"/></sheetView></sheetViews>`;
  }
  const dados = linhas
    .map((linha, i) => {
      const r = i + 1;
      const cels = (linha || []).map((c, j) => celulaXml(`${coluna(j)}${r}`, c)).join('');
      return cels ? `<row r="${r}">${cels}</row>` : '';
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${vista}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${dados}</sheetData>${filtro ? `<autoFilter ref="${filtro}"/>` : ''}<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/><pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}

function nomesFiltro(abas, nomes) {
  const itens = abas
    .map((a, i) =>
      a.filtro
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${nomes[i]}'!${a.filtro.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>`
        : ''
    )
    .join('');
  return itens ? `<definedNames>${itens}</definedNames>` : '';
}

/** abas: [{ nome, linhas, larguras, congelarLinhas, congelarColunas, filtro }] -> Uint8Array do .xlsx */
export function criarXlsx(abas) {
  const nomes = abas.map((a) => esc(a.nome.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31)));
  const arquivos = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${abas
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      )
      .join('')}</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${nomes
      .map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets>${nomesFiltro(abas, nomes)}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${abas
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
      )
      .join('')}<Relationship Id="rId${abas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': ESTILOS_XML,
  };
  abas.forEach((a, i) => (arquivos[`xl/worksheets/sheet${i + 1}.xml`] = abaXml(a)));
  return zipSync(Object.fromEntries(Object.entries(arquivos).map(([k, v]) => [k, strToU8(v)])), { level: 6 });
}

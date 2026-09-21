// Lenovo Machine Type Model prefixes. Sources: Lenovo Support/PSREF product pages.
// Intune often exports only the MTM code (for example 21HES4ND09), not "ThinkPad T14 Gen 4".
export const lenovoMtmMappings = [
  // ThinkPad T14
  ...entries(['20S0', '20S1', '20UD', '20UE'], 'ThinkPad T14', 'Gen 1'),
  ...entries(['20W0', '20W1', '20XK', '20XL'], 'ThinkPad T14', 'Gen 2'),
  ...entries(['21AH', '21AJ', '21CF', '21CG'], 'ThinkPad T14', 'Gen 3'),
  ...entries(['21HD', '21HE', '21K3', '21K4'], 'ThinkPad T14', 'Gen 4'),
  ...entries(['21ML', '21MM', '21MC', '21MD'], 'ThinkPad T14', 'Gen 5'),
  ...entries(['21QC', '21QD'], 'ThinkPad T14', 'Gen 6'),

  // ThinkPad T14s
  ...entries(['20T0', '20T1', '20UH', '20UJ'], 'ThinkPad T14s', 'Gen 1'),
  ...entries(['20WM', '20WN', '20XF', '20XG'], 'ThinkPad T14s', 'Gen 2'),
  ...entries(['21BR', '21BS', '21CQ', '21CR'], 'ThinkPad T14s', 'Gen 3'),
  ...entries(['21F6', '21F7', '21K7', '21K8'], 'ThinkPad T14s', 'Gen 4'),
  ...entries(['21LS', '21LT'], 'ThinkPad T14s', 'Gen 5'),

  // ThinkPad X1 Carbon / Yoga / 2-in-1
  ...entries(['20XW', '20XX'], 'ThinkPad X1 Carbon', 'Gen 9'),
  ...entries(['21CB', '21CC'], 'ThinkPad X1 Carbon', 'Gen 10'),
  ...entries(['21HM', '21HN'], 'ThinkPad X1 Carbon', 'Gen 11'),
  ...entries(['21KC', '21KD'], 'ThinkPad X1 Carbon', 'Gen 12'),
  ...entries(['20XY', '20Y0', '20Y6'], 'ThinkPad X1 Yoga', 'Gen 6'),
  ...entries(['21CD', '21CE'], 'ThinkPad X1 Yoga', 'Gen 7'),
  ...entries(['21HQ', '21HR'], 'ThinkPad X1 Yoga', 'Gen 8'),
  ...entries(['21KE', '21KF'], 'ThinkPad X1 2-in-1', 'Gen 9'),
  ...entries(['21Q1'], 'ThinkPad X1 2-in-1', 'Gen 10'),

  // ThinkPad X13
  ...entries(['20T2', '20T3'], 'ThinkPad X13', 'Gen 1'),
  ...entries(['20WK', '20WL'], 'ThinkPad X13', 'Gen 2'),
  ...entries(['21BN', '21BQ'], 'ThinkPad X13', 'Gen 3'),
  ...entries(['21EX', '21EY'], 'ThinkPad X13', 'Gen 4'),
  ...entries(['21LU', '21LV'], 'ThinkPad X13', 'Gen 5'),
  ...entries(['21RK', '21RL'], 'ThinkPad X13', 'Gen 6'),

  // ThinkPad P1
  ...entries(['21FV', '21FW'], 'ThinkPad P1', 'Gen 6'),
  ...entries(['21KV', '21KW'], 'ThinkPad P1', 'Gen 7'),
  ...entries(['21Q8', '21Q9'], 'ThinkPad P1', 'Gen 8'),

  // ThinkPad legacy T/X series
  ...entries(['20HD', '20HE'], 'ThinkPad T470', 'Standard'),
  ...entries(['20L5', '20L6'], 'ThinkPad T480', 'Standard'),
  ...entries(['20N2', '20N3'], 'ThinkPad T490', 'Standard'),
  ...entries(['20AM'], 'ThinkPad X240', 'Standard'),
  ...entries(['20HM', '20HN'], 'ThinkPad X270', 'Standard'),

  // ThinkPad L14 / L15
  ...entries(['20U1', '20U2', '20U5', '20U6'], 'ThinkPad L14', 'Gen 1'),
  ...entries(['20X1', '20X2', '20X4', '20X6'], 'ThinkPad L14', 'Gen 2'),
  ...entries(['21C1', '21C2', '21C5', '21C6'], 'ThinkPad L14', 'Gen 3'),
  ...entries(['21H1', '21H2', '21H5', '21H6'], 'ThinkPad L14', 'Gen 4'),
  ...entries(['21L1', '21L2', '21L5', '21L6'], 'ThinkPad L14', 'Gen 5'),
  ...entries(['21C3', '21C4', '21C7', '21C8'], 'ThinkPad L15', 'Gen 3'),
  ...entries(['21H3', '21H4', '21H7', '21H8'], 'ThinkPad L15', 'Gen 4'),

  // ThinkPad P14s / P16s
  ...entries(['20VX', '20VY'], 'ThinkPad P14s', 'Gen 2'),
  ...entries(['21AK', '21AL', '21J5', '21J6'], 'ThinkPad P14s', 'Gen 3'),
  ...entries(['21HF', '21HG', '21K5', '21K6'], 'ThinkPad P14s', 'Gen 4'),
  ...entries(['21ME', '21MF'], 'ThinkPad P14s', 'Gen 5'),
  ...entries(['21BT', '21BU', '21CK', '21CL'], 'ThinkPad P16s', 'Gen 1'),
  ...entries(['21HK', '21HL', '21K9', '21KA'], 'ThinkPad P16s', 'Gen 2'),

  // ThinkPad E14 / E15 / E16
  ...entries(['20RA', '20RB', '20T6', '20T7'], 'ThinkPad E14', 'Gen 1'),
  ...entries(['20TA', '20TB', '20T6', '20T7'], 'ThinkPad E14', 'Gen 2'),
  ...entries(['20Y7', '20YD'], 'ThinkPad E14', 'Gen 3'),
  ...entries(['21E3', '21E4', '21EB', '21EC'], 'ThinkPad E14', 'Gen 4'),
  ...entries(['21JK', '21JL', '21JR', '21JS'], 'ThinkPad E14', 'Gen 5'),
  ...entries(['21M3', '21M4'], 'ThinkPad E14', 'Gen 6'),
  ...entries(['21ED', '21EE'], 'ThinkPad E15', 'Gen 4'),
  ...entries(['21JN', '21JQ', '21JT', '21JU'], 'ThinkPad E16', 'Gen 1'),
  ...entries(['21MA', '21MB'], 'ThinkPad E16', 'Gen 2')
];

export function resolveLenovoMtmPrefix(value) {
  const prefix = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  return lenovoMtmMappings.find((item) => item.prefix === prefix) ?? null;
}

/**
 * Pull a Lenovo MTM out of glued PDF text (e.g. "221Q1S2770HLENOVO" → "21Q1S2770H").
 */
export function extractLenovoMtmCode(value) {
  const compact = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!compact) return '';

  const glued = compact.match(/^[0-9]?([0-9]{2}[A-Z0-9]{6,9}H?)LENOVO/);
  if (glued && resolveLenovoMtmPrefix(glued[1])) return glued[1];

  for (let start = 0; start <= 2 && start < compact.length - 7; start++) {
    for (const len of [11, 10, 9, 8]) {
      if (start + len > compact.length) continue;
      const cand = compact.slice(start, start + len);
      if (/^[0-9]{2}[A-Z0-9]{6,}H?$/.test(cand) && resolveLenovoMtmPrefix(cand)) return cand;
    }
  }

  const bare = compact.match(/([0-9]{2}[A-Z0-9]{6,9}H?)/);
  return bare && resolveLenovoMtmPrefix(bare[1]) ? bare[1] : '';
}

function entries(prefixes, name, generation) {
  return prefixes.map((prefix) => ({ prefix, name, generation }));
}

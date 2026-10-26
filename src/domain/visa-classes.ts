// Only fixed visa-class codes may leave the device, never portal descriptions
// or applicant-level mappings. Unknown/new portal values remain unknown.
export const VISA_CLASSES = [
  'A1', 'A2', 'A3', 'B1', 'B2', 'B1/B2', 'C1', 'C2', 'C3', 'C1/D', 'D',
  'E1', 'E2', 'E3', 'E3D', 'E3R', 'F1', 'F2', 'G1', 'G2', 'G3', 'G4', 'G5',
  'H1B', 'H1B1', 'H1C', 'H2A', 'H2B', 'H3', 'H4', 'I', 'J1', 'J2',
  'K1', 'K2', 'K3', 'K4', 'L1', 'L1A', 'L1B', 'L2', 'M1', 'M2', 'M3',
  'N8', 'N9', 'NATO1', 'NATO2', 'NATO3', 'NATO4', 'NATO5', 'NATO6', 'NATO7',
  'O1', 'O2', 'O3', 'P1', 'P1A', 'P1B', 'P2', 'P3', 'P4', 'Q1', 'R1', 'R2',
  'S5', 'S6', 'S7', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'TN', 'TD',
  'U1', 'U2', 'U3', 'U4', 'U5', 'V1', 'V2', 'V3', 'unknown',
] as const;
export type VisaClass = (typeof VISA_CLASSES)[number];

export function isVisaClasses(value: unknown): value is VisaClass[] {
  return Array.isArray(value) && value.length > 0 && value.length <= VISA_CLASSES.length &&
    Array.from(value).every((code, index) => VISA_CLASSES.includes(code) && (index === 0 || value[index - 1] < code));
}

// For optional local metadata: corruption must not block booking/verification.
export function safeVisaClasses(value: unknown): VisaClass[] {
  return isVisaClasses(value) ? [...value] : ['unknown'];
}

export function normalizeVisaClassLabels(value: unknown): VisaClass[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) return ['unknown'];
  const codes = Array.from(value, (label): VisaClass => {
    if (typeof label !== 'string' || label.length > 160) return 'unknown';
    // The explicit Visa Class cell starts with the class, followed by its
    // description. Accept H-1B / B-1/B-2 spellings, but never search arbitrary
    // page text for a class-like substring.
    const token = label.trim().toUpperCase().match(/^([A-Z][A-Z0-9/-]*)(?:\s|$)/)?.[1]?.replaceAll('-', '');
    return VISA_CLASSES.includes(token as VisaClass) ? token as VisaClass : 'unknown';
  });
  return [...new Set(codes)].sort();
}

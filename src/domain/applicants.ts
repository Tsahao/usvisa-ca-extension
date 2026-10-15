// Reject empty, duplicate, or malformed rosters; never silently filter IDs.
export function validateApplicantIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100 ||
      !value.every(id => typeof id === 'string' && /^[0-9]{1,32}$/.test(id)) ||
      new Set(value).size !== value.length) throw new Error('Invalid applicant roster.');
  return [...value].sort();
}

export function sameApplicants(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(validateApplicantIds(left)) === JSON.stringify(validateApplicantIds(right));
  } catch { return false; }
}

// Shared topical-relevance keywords for ingest + cleanup scripts.
//
// A document is considered topical if its title or abstract contains
// at least one of these phrases (case-insensitive substring match).
// Keep these tight on purpose — false positives are worse than misses.
// Federal Register full-text search returns SEC, DOL, NLRB rules that
// only mention "estate tax" in passing; this list filters those out.

const CORE_KEYWORDS = [
  // --- Estate / gift / GST / inheritance tax (existing core) ---
  'estate tax',
  'estate taxes',
  'gift tax',
  'gift taxes',
  'generation-skipping',
  'generation skipping',
  'gst tax',
  'gst transfer',
  'inheritance tax',
  'inheritance taxes',
  // IRS forms specific to estate / gift / GST
  'form 706',
  'form 709',
  // Estate-planning / trust-tax phrases
  'estate planning',
  'estate and gift',
  'gift and estate',
  'estate, gift',
  'gift, estate',
  'applicable exclusion',
  'unified credit',
  'grantor trust',
  'grantor trusts',
  'trust taxation',
  'trust tax',
  // IRC Subtitle B (estate, gift, GST taxes are Chapters 11, 12, 13)
  'chapter 11 of the internal revenue code',
  'chapter 12 of the internal revenue code',
  'chapter 13 of the internal revenue code',
  'subtitle b of the internal revenue code',

  // --- Tier 1: trust admin, fiduciary, charitable, basis, opportunity zones ---
  'trust administration',
  'fiduciary',
  'probate',
  'charitable giving',
  'charitable deduction',
  'donor advised fund',
  'private foundation',
  'step-up in basis',
  'stepped-up basis',
  'qualified opportunity zone',
  'opportunity zone',
  '501(c)(3)',
  'charitable remainder',
  'charitable lead trust',

  // --- Tier 2: retirement accounts, insurance, state-level, wealth management ---
  'individual retirement account',
  'ira distribution',
  'required minimum distribution',
  'rmd',
  'inherited ira',
  'life insurance',
  'annuity',
  'state estate tax',
  'state inheritance tax',
  'wealth transfer',
  'high net worth',
  'family office',
];

function haystack(parts) {
  return parts
    .filter((p) => typeof p === 'string' && p.length > 0)
    .join(' \n ')
    .toLowerCase();
}

// Returns true if any core keyword appears in the joined text.
function isRelevant(...texts) {
  const s = haystack(texts);
  if (!s) return false;
  return CORE_KEYWORDS.some((k) => s.includes(k));
}

module.exports = { CORE_KEYWORDS, isRelevant };

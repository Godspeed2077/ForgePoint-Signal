// Shared between scripts/ingest.js and scripts/ingest-irs.js so re-runs
// don't pay for Claude on documents we've already stored.
//
// Reads SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY)
// from env. Returns null if either is missing — the ingest scripts then
// skip the pre-check entirely and proceed straight to Claude (conservative;
// missing config disables the optimization but doesn't break ingestion).
//
// The anon key is sufficient because regulatory_entries has a public read
// policy ("regulatory_entries_read"). Using the anon key here also limits
// the script's blast radius — only the API server holds the service-role
// key and is allowed to write.

const { createClient } = require('@supabase/supabase-js');

function makeSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn(
      '  SUPABASE_URL or SUPABASE_ANON_KEY missing — pre-check disabled, every doc will be sent to Claude.',
    );
    return null;
  }
  return createClient(url, key);
}

// True if a row with the given source_url already exists in
// regulatory_entries. Errors fall through to "false" (proceed with Claude)
// so a flaky Supabase doesn't block ingestion.
async function entryExists(client, sourceUrl) {
  if (!client || !sourceUrl) return false;
  const { data, error } = await client
    .from('regulatory_entries')
    .select('id')
    .eq('source_url', sourceUrl)
    .maybeSingle();
  if (error) {
    console.warn(
      `    pre-check error for ${sourceUrl}: ${error.message} (proceeding to Claude)`,
    );
    return false;
  }
  return Boolean(data);
}

module.exports = { makeSupabaseClient, entryExists };

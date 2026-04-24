// One-shot cleanup: removes regulatory_entries rows whose text doesn't
// match any topical keyword. Run with --apply to actually delete; without
// --apply it's a dry-run that just prints what would be removed.
//
//   npm run cleanup:off-topic                            # dry-run, checks title + summary + abstract
//   npm run cleanup:off-topic -- --apply                 # delete for real
//   npm run cleanup:off-topic -- --title-only            # dry-run, checks title only (stricter)
//   npm run cleanup:off-topic -- --title-only --apply    # delete for real, title-only
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from env. Does NOT go
// through the API — talks directly to Supabase, so it needs the service
// role key, which bypasses RLS.

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { CORE_KEYWORDS, isRelevant } = require('./keywords.js');

async function main() {
  const apply = process.argv.includes('--apply');
  const titleOnly = process.argv.includes('--title-only');

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL is required');
  if (!serviceKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is required (the anon key cannot delete rows under RLS)',
    );
  }

  const supabase = createClient(url, serviceKey);

  console.log(`Mode: ${apply ? 'APPLY (will delete)' : 'dry-run (no writes)'}`);
  console.log(`Match scope: ${titleOnly ? 'title only' : 'title + summary + abstract'}`);
  console.log(`Keyword set: ${CORE_KEYWORDS.length} terms`);

  // Pull every row in pages of 1000 (Supabase REST default cap).
  let offset = 0;
  const pageSize = 1000;
  const offTopic = [];
  let total = 0;
  while (true) {
    const { data, error } = await supabase
      .from('regulatory_entries')
      .select(
        'id, source, title, summary, source_url, raw_json',
        { count: 'exact' },
      )
      .order('created_at', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`select failed: ${error.message}`);
    if (!data || data.length === 0) break;
    total += data.length;
    for (const row of data) {
      const abstract = row.raw_json?.abstract || '';
      const matched = titleOnly
        ? isRelevant(row.title)
        : isRelevant(row.title, row.summary, abstract);
      if (!matched) offTopic.push(row);
    }
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`Scanned ${total} rows; ${offTopic.length} are off-topic.`);
  if (offTopic.length === 0) {
    console.log('Nothing to remove. Done.');
    return;
  }

  console.log('\nOff-topic rows:');
  for (const row of offTopic) {
    console.log(
      `  - [${row.source || 'unknown'}] ${row.id}  "${(row.title || '').slice(0, 80)}"`,
    );
  }

  if (!apply) {
    console.log(
      `\nDry-run: no rows deleted. Re-run with \`npm run cleanup:off-topic -- --apply\` to delete the ${offTopic.length} rows above.`,
    );
    return;
  }

  console.log(`\nDeleting ${offTopic.length} rows...`);
  // Delete in chunks of 100 IDs to keep the IN list reasonable.
  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < offTopic.length; i += 100) {
    const ids = offTopic.slice(i, i + 100).map((r) => r.id);
    const { error } = await supabase
      .from('regulatory_entries')
      .delete()
      .in('id', ids);
    if (error) {
      failed += ids.length;
      console.error(`  chunk ${i}-${i + ids.length} failed: ${error.message}`);
    } else {
      deleted += ids.length;
      console.log(`  deleted ${i + ids.length}/${offTopic.length}`);
    }
  }
  console.log(`\nDone. Deleted: ${deleted}. Failed: ${failed}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

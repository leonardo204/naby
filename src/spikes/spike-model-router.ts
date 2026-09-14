// src/spikes/spike-model-router.ts
//
// M1 verification: THE MODEL ROUTER — specs/model-auto-routing.md §4.2–§4.4.
//
// The router is pure, so this spike needs no account, no network, no store and
// no database: it calls the real decision function with the real signal shapes
// and asserts the tier AND the reason, because "right model for the wrong
// reason" is how a routing table rots without anyone noticing.
//
// Asserted:
//   BASE TIER (§4.2 rule 1)
//     (a) plan mode → fable, whatever the text says.
//     (b) design verbs with no build verb → fable; a build verb cancels them.
//     (c) build verbs, a code fence, two file paths, or >1,200 chars → opus.
//     (d) full mode at pupa/butterfly → opus; at egg/larva it does not apply.
//     (e) short, code-free, path-free, URL-free and verb-free → haiku.
//     (f) anything else → sonnet, including the ambiguous middle.
//     (g) Korean phrasings of each, since that is the language of the app.
//     (g2) Latin keywords match WHOLE WORDS ("explain" is not `plan`), Korean
//          keywords keep substring matching ("설계해줘" is `설계`).
//   STICKY (§4.2 rule 2)
//     (h) past 40k the session keeps a stronger previous tier…
//     (i) …and below 40k it does not, and it never pulls a turn DOWN.
//   WINDOW FIT (§4.2 rule 3)
//     (j) a 250k conversation moves a haiku turn to opus.
//     (k) when nothing fits, the largest known window wins.
//     (l) an unknown window is not treated as a fitting one.
//   BUDGET CAP (§4.2 rule 4)
//     (m) opusPct/fiveHourPct ≥ 90 lowers opus and fable to sonnet…
//     (n) …but NOT when sonnet cannot hold the conversation,
//     (o) …and not at all when no usage was passed, or the percentages are absent.
//   CATALOG (§4.3)
//     (p) the real cache shape, and the no-catalog fallback.
//     (q) windows measured end-to-end through the real `contextWindowFor`,
//         including the `opus[1m]` → 1M lookup this milestone depends on.
//   IDS AND ESTIMATES (§4.4)
//     (r) `tierOfModelId` on resolved ids, aliases and garbage.
//     (s) `estimateContextTokens` over a typed `RuntimeMessage[]` — including a
//         tool row, with no cast, which is the compile-time proof that what
//         `store.getMessages()` returns is accepted as it is.
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import {
  CLAUDE_1M_CONTEXT_WINDOW,
  CLAUDE_CONTEXT_WINDOW,
  contextWindowFor,
} from '../runtime/context-window.js';
import type { RuntimeMessage } from '../runtime/engine.js';
import {
  BUDGET_CAP_PCT,
  BUILD_KEYWORDS,
  DESIGN_KEYWORDS,
  containsKeyword,
  STICKY_MIN_TOKENS,
  SYSTEM_PROMPT_TOKENS,
  estimateContextTokens,
  pickCatalogValue,
  requiredWindow,
  routeModelTier,
  tierOfModelId,
  tierRank,
  windowsForTiers,
  type CatalogRow,
  type ModelTier,
  type RouteDecision,
  type RouteSignals,
} from '../runtime/model-router.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The live catalog as the app caches it (`models.claude.cache`, spec §3). */
const LIVE_CATALOG: CatalogRow[] = [
  { value: 'default', resolvedModel: 'claude-opus-5[1m]' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]' },
  { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
];

/** Windows as the shell will compute them from that catalog. */
const LIVE_WINDOWS = windowsForTiers(
  (tier) => pickCatalogValue(tier, LIVE_CATALOG),
  (value) => contextWindowFor('dev-claude', value),
);

/** A small conversation: nothing but the system-prompt share. */
const SMALL_CONTEXT = SYSTEM_PROMPT_TOKENS;

function route(text: string, over: Partial<RouteSignals> = {}): RouteDecision {
  const signals: RouteSignals = {
    text,
    fullMode: false,
    planMode: false,
    estimatedContextTokens: SMALL_CONTEXT,
    windows: LIVE_WINDOWS,
    ...over,
  };
  return routeModelTier(signals);
}

function expectRoute(
  name: string,
  text: string,
  over: Partial<RouteSignals>,
  tier: ModelTier,
  reason: RouteDecision['reason'],
): void {
  const got = route(text, over);
  record(
    name,
    got.tier === tier && got.reason === reason,
    `want ${tier}/${reason}, got ${got.tier}/${got.reason}`,
  );
}

// ---------------------------------------------------------------------------
// (a)-(g) base tier
// ---------------------------------------------------------------------------

function checkBaseTier(): void {
  // (a) plan mode outranks the text, which in a plan-mode turn is usually the
  //     build request itself.
  expectRoute('(a) plan mode → fable', '이 버그 고쳐줘', { planMode: true }, 'fable', 'plan-mode');
  expectRoute('(a) plan mode, English → fable', 'fix the login bug', { planMode: true }, 'fable', 'plan-mode');

  // (b) design verbs, Korean and English, and the build-verb veto.
  expectRoute('(b) "설계 검토해줘" → fable', '설계 검토해줘', {}, 'fable', 'design-ask');
  expectRoute('(b) "review the architecture" → fable', 'Could you review the architecture here?', {}, 'fable', 'design-ask');
  expectRoute(
    '(b) design + build verb → opus (build wins)',
    '이 설계대로 구현해줘',
    {},
    'opus',
    'build-ask',
  );

  // (c) build turns, by verb / fence / paths / length.
  expectRoute('(c) "이 함수 리팩터해줘" → opus', '이 함수 리팩터해줘', {}, 'opus', 'build-ask');
  expectRoute('(c) "fix this" → opus', 'fix this please', {}, 'opus', 'build-ask');
  expectRoute(
    '(c) code fence → opus',
    '이거 봐줘\n```ts\nconst a = 1;\n```',
    {},
    'opus',
    'build-ask',
  );
  expectRoute(
    '(c) two file paths → opus',
    'src/runtime/engine.ts 와 src/runtime/voice.ts 좀 봐줘',
    {},
    'opus',
    'build-ask',
  );
  expectRoute(
    '(c) >1,200 chars → opus',
    '이번 턴에서 하고 싶은 일을 길게 적어 본다. '.repeat(60),
    {},
    'opus',
    'build-ask',
  );

  // ONE path is not two. A single-path question must not be read as a change
  // request — the bare-filename pattern overlaps the slash-path one, so this is
  // the assertion that keeps the two from double-counting.
  const onePath = route('src/runtime/engine.ts 이거 뭐 하는 파일이야?');
  record(
    '(c) ONE file path is not a build ask',
    onePath.tier === 'sonnet' && onePath.reason === 'default',
    `want sonnet/default, got ${onePath.tier}/${onePath.reason}`,
  );

  // (d) full mode, by stage.
  expectRoute('(d) full mode + butterfly → opus', '@naby 오늘 뭐 해야 해?', { fullMode: true, stage: 'butterfly' }, 'opus', 'full-mode');
  expectRoute('(d) full mode + pupa → opus', '@naby 오늘 뭐 해야 해?', { fullMode: true, stage: 'pupa' }, 'opus', 'full-mode');
  expectRoute('(d) full mode + larva does NOT apply', '@naby 안녕', { fullMode: true, stage: 'larva' }, 'haiku', 'chat');

  // (e) small talk, the only way down.
  expectRoute('(e) "안녕" → haiku', '안녕', {}, 'haiku', 'chat');
  expectRoute('(e) "thanks!" → haiku', 'thanks!', {}, 'haiku', 'chat');

  // …and each disqualifier on its own sends it back up to sonnet.
  expectRoute('(e) short + inline code → not haiku', '`foo` 이게 뭐야?', {}, 'sonnet', 'default');
  expectRoute('(e) short + URL → not haiku', '이거 봐 https://example.com/x', {}, 'sonnet', 'default');
  expectRoute('(e) short + one path → not haiku', 'src/runtime/gate.ts 이게 뭐야', {}, 'sonnet', 'default');

  // (f) the ambiguous middle: too long to be small talk, no verb to classify it,
  //     nothing that looks like work. This is the turn the spec sends to sonnet.
  const medium = '어제 이야기한 방식이랑 지금 방식이랑 어떤 차이가 있는지 좀 길게 알려줄 수 있어? 궁금해서 물어본다. '.repeat(4);
  record(
    '(f) the ambiguous middle is over 200 chars and under 1,200',
    medium.length > 200 && medium.length <= 1_200,
    `${medium.length} chars`,
  );
  expectRoute('(f) medium question with no verbs → sonnet', medium, {}, 'sonnet', 'default');

  // (g) an empty turn is not small talk in the dangerous direction — it is the
  //     shortest possible text, so it lands on haiku, which is harmless.
  const empty = route('');
  record('(g) empty text does not throw', empty.tier === 'haiku' && empty.reason === 'chat', `${empty.tier}/${empty.reason}`);
}

// ---------------------------------------------------------------------------
// (g2) Latin keywords match WHOLE WORDS
//
// The substring rule the spec asks for is right for Korean and wrong for
// English: `plan` ⊂ "explain", `spec` ⊂ "specific"/"inspect", `test` ⊂ "latest",
// `fix` ⊂ "prefix". A design misroute is SIDEWAYS, not upward, so it is not
// covered by "leaning up is safe" — these are the assertions that keep it from
// coming back.
// ---------------------------------------------------------------------------

function checkWordBoundaries(): void {
  // The four traps, by tier.
  expectRoute('(g2) "explain this function" is not a design ask', 'explain this function', {}, 'haiku', 'chat');
  const especially = route('especially the specific part, and inspect it');
  record(
    '(g2) especially/specific/inspect do not match `spec`',
    especially.tier !== 'fable',
    `${especially.tier}/${especially.reason}`,
  );
  const latest = route('latest results');
  record('(g2) "latest" does not match `test`', latest.tier !== 'opus', `${latest.tier}/${latest.reason}`);
  const prefix = route('what does the prefix mean here');
  record('(g2) "prefix" does not match `fix`', prefix.tier !== 'opus', `${prefix.tier}/${prefix.reason}`);

  // …and the real words still land.
  expectRoute('(g2) "please review the design" → fable', 'please review the design', {}, 'fable', 'design-ask');
  expectRoute('(g2) "fix the failing tests" → opus', 'fix the failing tests', {}, 'opus', 'build-ask');
  expectRoute('(g2) inflections count: "planning the architecture"', 'planning the architecture', {}, 'fable', 'design-ask');
  expectRoute('(g2) inflections count: "refactoring this module"', 'refactoring this module', {}, 'opus', 'build-ask');

  // Punctuation is a boundary, capitals are not a hiding place.
  expectRoute('(g2) "Review, please." → fable', 'Review, please.', {}, 'fable', 'design-ask');

  // Korean keeps SUBSTRING matching: particles and endings attach with no space.
  record(
    '(g2) Korean matches without a boundary (설계해줘 / 검토좀 / 설계대로)',
    containsKeyword('설계해줘', DESIGN_KEYWORDS) &&
      containsKeyword('검토좀 해줄래', DESIGN_KEYWORDS) &&
      containsKeyword('구현해줘', BUILD_KEYWORDS),
    'all three matched',
  );
  record(
    '(g2) containsKeyword is word-wise for Latin, substring-wise for Korean',
    !containsKeyword('explain', DESIGN_KEYWORDS) &&
      !containsKeyword('specific', DESIGN_KEYWORDS) &&
      containsKeyword('the plan', DESIGN_KEYWORDS) &&
      !containsKeyword('latest', BUILD_KEYWORDS) &&
      containsKeyword('run the test', BUILD_KEYWORDS),
    'explain/specific/latest miss, plan/test hit',
  );
}

// ---------------------------------------------------------------------------
// (h)-(i) sticky
// ---------------------------------------------------------------------------

function checkSticky(): void {
  const big = STICKY_MIN_TOKENS + 10_000;

  expectRoute(
    '(h) past 40k a greeting keeps the previous opus',
    '안녕',
    { estimatedContextTokens: big, previousTier: 'opus' },
    'opus',
    'sticky',
  );
  expectRoute(
    '(h) past 40k a greeting keeps the previous fable',
    '안녕',
    { estimatedContextTokens: big, previousTier: 'fable' },
    'fable',
    'sticky',
  );
  expectRoute(
    '(i) at exactly 40k it does not stick (threshold is exclusive)',
    '안녕',
    { estimatedContextTokens: STICKY_MIN_TOKENS, previousTier: 'opus' },
    'haiku',
    'chat',
  );
  expectRoute(
    '(i) sticky never pulls a turn DOWN',
    '이 버그 고쳐줘',
    { estimatedContextTokens: big, previousTier: 'haiku' },
    'opus',
    'build-ask',
  );

  record(
    '(i) tier order is haiku < sonnet < opus < fable',
    tierRank('haiku') < tierRank('sonnet') &&
      tierRank('sonnet') < tierRank('opus') &&
      tierRank('opus') < tierRank('fable'),
    `haiku=${tierRank('haiku')} sonnet=${tierRank('sonnet')} opus=${tierRank('opus')} fable=${tierRank('fable')}`,
  );
}

// ---------------------------------------------------------------------------
// (j)-(l) window fit
// ---------------------------------------------------------------------------

function checkWindowFit(): void {
  const huge = 250_000;
  const required = requiredWindow(huge);
  record(
    '(j) 250k estimate needs 395k of window (×1.5 + 20k)',
    required === 395_000,
    `requiredWindow(250000) = ${required}`,
  );

  expectRoute(
    '(j) a greeting in a 250k conversation goes to opus',
    '안녕',
    { estimatedContextTokens: huge },
    'opus',
    'window-fit',
  );

  // A design turn keeps its own tier: fable is 1M through the live catalog.
  expectRoute(
    '(j) a design turn in a 250k conversation stays fable',
    '설계 검토해줘',
    { estimatedContextTokens: huge },
    'fable',
    'design-ask',
  );

  // (k) nothing fits → the largest known window, not a failure and not a guess.
  const noCatalogWindows = windowsForTiers(
    (tier) => pickCatalogValue(tier, undefined),
    (value) => contextWindowFor('dev-claude', value),
  );
  const nothingFits = route('안녕', {
    estimatedContextTokens: 900_000,
    windows: { haiku: 200_000, sonnet: 200_000, opus: 1_000_000, fable: 1_000_000 },
  });
  record(
    '(k) nothing fits → the largest known window',
    nothingFits.tier === 'opus' && nothingFits.reason === 'window-fit',
    `${nothingFits.tier}/${nothingFits.reason} (required ${requiredWindow(900_000)})`,
  );

  // Without a catalog fable measures 200k, so a big design turn is moved to opus
  // — the honest consequence of the information available (see pickCatalogValue).
  const fableNoCatalog = route('설계 검토해줘', {
    estimatedContextTokens: huge,
    windows: noCatalogWindows,
  });
  record(
    '(k) no catalog: a big design turn is moved to opus',
    fableNoCatalog.tier === 'opus' && fableNoCatalog.reason === 'window-fit',
    `${fableNoCatalog.tier}/${fableNoCatalog.reason}, fable window ${String(noCatalogWindows.fable)}`,
  );

  // (j) A TIE GOES UP. The chosen tier is sonnet and its window cannot hold the
  // turn; haiku and opus both can, and they sit one place away on either side.
  // The rule says the higher one, and the reason is the same one that makes the
  // whole window rule a qualification rather than a price: a turn moved DOWN to
  // haiku because sonnet did not fit has been made cheaper and worse for no
  // reason anybody asked for. Synthetic windows — no real catalog puts haiku
  // above sonnet — because a tie cannot otherwise be constructed from the sizes
  // Anthropic actually ships.
  const tie = route(
    // Long enough to miss `chat` (>200 chars) with no build/design verb, no code
    // fence and no path, so the base tier is `default` → sonnet.
    '오늘 날씨가 참 좋네요. '.repeat(20),
    {
      estimatedContextTokens: 50_000,
      windows: { haiku: 500_000, sonnet: 10_000, opus: 500_000, fable: 10_000 },
    },
  );
  record(
    '(j) a tie in distance goes UP: sonnet does not fit, haiku and opus both do → opus',
    tie.tier === 'opus' && tie.reason === 'window-fit',
    `${tie.tier}/${tie.reason} (required ${requiredWindow(50_000)}, haiku and opus at 500,000)`,
  );

  // (l) an UNKNOWN window never counts as fitting.
  const unknown = route('안녕', {
    estimatedContextTokens: huge,
    windows: { haiku: 200_000, sonnet: undefined, opus: 1_000_000, fable: undefined },
  });
  record(
    '(l) an unknown window is not a fitting one',
    unknown.tier === 'opus' && unknown.reason === 'window-fit',
    `${unknown.tier}/${unknown.reason}`,
  );
}

// ---------------------------------------------------------------------------
// (m)-(o) budget cap
// ---------------------------------------------------------------------------

function checkBudgetCap(): void {
  expectRoute(
    '(m) opusPct 90 lowers a build turn to sonnet',
    '이 함수 리팩터해줘',
    { usage: { opusPct: BUDGET_CAP_PCT } },
    'sonnet',
    'budget-cap',
  );
  expectRoute(
    '(m) fiveHourPct 95 lowers a design turn to sonnet',
    '설계 검토해줘',
    { usage: { fiveHourPct: 95 } },
    'sonnet',
    'budget-cap',
  );
  expectRoute(
    '(m) opusPct 89 does not',
    '이 함수 리팩터해줘',
    { usage: { opusPct: 89 } },
    'opus',
    'build-ask',
  );

  // (n) the veto: sonnet cannot hold a 250k conversation, so the cap stands down.
  const vetoed = route('이 함수 리팩터해줘', {
    estimatedContextTokens: 250_000,
    usage: { opusPct: 99, fiveHourPct: 99 },
  });
  record(
    '(n) budget cap does NOT lower below what window-fit requires',
    vetoed.tier === 'opus' && vetoed.reason !== 'budget-cap',
    `${vetoed.tier}/${vetoed.reason}`,
  );

  // (o) no usage at all, and usage with no numbers in it.
  expectRoute('(o) no usage → no cap', '이 함수 리팩터해줘', {}, 'opus', 'build-ask');
  expectRoute('(o) usage present but empty → no cap', '이 함수 리팩터해줘', { usage: {} }, 'opus', 'build-ask');
  expectRoute(
    '(o) the cap never touches sonnet or haiku',
    '안녕',
    { usage: { opusPct: 100, fiveHourPct: 100 } },
    'haiku',
    'chat',
  );
}

// ---------------------------------------------------------------------------
// (p)-(q) catalog and windows
// ---------------------------------------------------------------------------

function checkCatalog(): void {
  const withCatalog: Record<ModelTier, string> = {
    opus: pickCatalogValue('opus', LIVE_CATALOG),
    fable: pickCatalogValue('fable', LIVE_CATALOG),
    sonnet: pickCatalogValue('sonnet', LIVE_CATALOG),
    haiku: pickCatalogValue('haiku', LIVE_CATALOG),
  };
  record(
    '(p) live catalog → opus[1m] / claude-fable-5-1[1m] / sonnet / haiku',
    withCatalog.opus === 'opus[1m]' &&
      withCatalog.fable === 'claude-fable-5-1[1m]' &&
      withCatalog.sonnet === 'sonnet' &&
      withCatalog.haiku === 'haiku',
    JSON.stringify(withCatalog),
  );

  const withoutCatalog: Record<ModelTier, string> = {
    opus: pickCatalogValue('opus', undefined),
    fable: pickCatalogValue('fable', undefined),
    sonnet: pickCatalogValue('sonnet', undefined),
    haiku: pickCatalogValue('haiku', undefined),
  };
  record(
    '(p) no catalog → opus[1m] kept, fable falls back to the alias',
    withoutCatalog.opus === 'opus[1m]' &&
      withoutCatalog.fable === 'fable' &&
      withoutCatalog.sonnet === 'sonnet' &&
      withoutCatalog.haiku === 'haiku',
    JSON.stringify(withoutCatalog),
  );

  const emptyCatalog = pickCatalogValue('fable', []);
  record('(p) empty catalog → fable alias', emptyCatalog === 'fable', emptyCatalog);

  // (q) the dependency this whole milestone rests on: the catalog's own opus
  //     value measures 1M. It did NOT before this change — `contextWindowFor`
  //     matched neither `claude` nor the bare alias and answered undefined, which
  //     would have made opus ineligible for every long conversation.
  record(
    "(q) contextWindowFor('dev-claude','opus[1m]') is 1M",
    contextWindowFor('dev-claude', 'opus[1m]') === CLAUDE_1M_CONTEXT_WINDOW,
    String(contextWindowFor('dev-claude', 'opus[1m]')),
  );
  record(
    '(q) bare aliases still measure 200k',
    contextWindowFor('dev-claude', 'opus') === CLAUDE_CONTEXT_WINDOW &&
      contextWindowFor('dev-claude', 'sonnet') === CLAUDE_CONTEXT_WINDOW &&
      contextWindowFor('dev-claude', 'haiku') === CLAUDE_CONTEXT_WINDOW &&
      contextWindowFor('dev-claude', 'fable') === CLAUDE_CONTEXT_WINDOW,
    `opus=${String(contextWindowFor('dev-claude', 'opus'))} sonnet=${String(contextWindowFor('dev-claude', 'sonnet'))}`,
  );
  record(
    "(q) 'default' is still an unknown window",
    contextWindowFor('dev-claude', 'default') === undefined,
    String(contextWindowFor('dev-claude', 'default')),
  );
  record(
    '(q) windowsForTiers over the live catalog: opus/fable 1M, sonnet/haiku 200k',
    LIVE_WINDOWS.opus === CLAUDE_1M_CONTEXT_WINDOW &&
      LIVE_WINDOWS.fable === CLAUDE_1M_CONTEXT_WINDOW &&
      LIVE_WINDOWS.sonnet === CLAUDE_CONTEXT_WINDOW &&
      LIVE_WINDOWS.haiku === CLAUDE_CONTEXT_WINDOW,
    JSON.stringify(LIVE_WINDOWS),
  );
}

// ---------------------------------------------------------------------------
// (r) ids back to tiers
// ---------------------------------------------------------------------------

function checkTierOfModelId(): void {
  const cases: Array<[string | undefined, ModelTier | undefined]> = [
    ['claude-opus-5[1m]', 'opus'],
    ['claude-opus-4-1-20250805', 'opus'],
    ['claude-haiku-4-5-20251001', 'haiku'],
    ['claude-sonnet-4-5', 'sonnet'],
    ['claude-fable-5-1', 'fable'],
    ['claude-fable-5-1[1m]', 'fable'],
    ['opus[1m]', 'opus'],
    ['OPUS', 'opus'],
    ['  sonnet  ', 'sonnet'],
    ['fable', 'fable'],
    ['default', undefined],
    ['gpt-5.6-sol', undefined],
    ['', undefined],
    [undefined, undefined],
    ['꿈나라', undefined],
  ];
  const wrong = cases.filter(([id, want]) => tierOfModelId(id) !== want);
  record(
    '(r) tierOfModelId maps resolved ids, aliases and nothing else',
    wrong.length === 0,
    wrong.length === 0
      ? `${cases.length} cases`
      : wrong.map(([id, want]) => `${String(id)}: want ${String(want)}, got ${String(tierOfModelId(id))}`).join('; '),
  );
}

// ---------------------------------------------------------------------------
// (s) occupancy estimate
// ---------------------------------------------------------------------------

function checkEstimate(): void {
  // NO CAST on this array. It is a `RuntimeMessage[]` exactly as the store hands
  // it back, tool row included — if the parameter type ever narrows so that a
  // tool row is rejected, this file stops compiling.
  const history: RuntimeMessage[] = [
    { role: 'user', content: '세션 스토어를 어디에 둘까?' },
    { role: 'assistant', content: '런타임에 둔다. 프로바이더를 바꿔도 남아야 하기 때문이다.' },
    {
      role: 'tool',
      toolCallId: 'call-1',
      toolName: 'read_file',
      output: { content: 'x'.repeat(3_500) },
    },
    { role: 'user', content: 'ㅇㅋ' },
  ];

  const empty = estimateContextTokens([]);
  record(
    '(s) an empty conversation is the system-prompt share, not zero',
    empty === SYSTEM_PROMPT_TOKENS,
    `${empty} tokens`,
  );

  const withHistory = estimateContextTokens(history);
  // The tool row alone is ~1,000 tokens, so the history has to move the number
  // well past the flat share, and the total stays a plausible lower bound.
  const plausible = withHistory > SYSTEM_PROMPT_TOKENS + 900 && withHistory < SYSTEM_PROMPT_TOKENS + 2_000;
  record(
    '(s) a real history (tool row included) adds a plausible amount',
    plausible,
    `${withHistory} tokens for ${history.length} messages`,
  );

  const strings = estimateContextTokens(['a'.repeat(3_500), 'b'.repeat(3_500)]);
  record(
    '(s) bare strings are accepted and counted (7,000 chars ≈ 2k tokens)',
    strings > SYSTEM_PROMPT_TOKENS + 1_900 && strings < SYSTEM_PROMPT_TOKENS + 2_100,
    `${strings} tokens`,
  );

  const blocks = estimateContextTokens([
    { role: 'user', content: [{ type: 'text', text: 'c'.repeat(3_500) }, { type: 'image', data: 'ignored' }] },
  ]);
  record(
    '(s) block arrays count their text parts and ignore the rest',
    blocks > SYSTEM_PROMPT_TOKENS + 900 && blocks < SYSTEM_PROMPT_TOKENS + 1_100,
    `${blocks} tokens`,
  );

  // The estimate feeds the window rule, so the end-to-end path matters more than
  // the number: a 250k-token history must route a greeting to opus.
  const long: RuntimeMessage[] = Array.from({ length: 250 }, () => ({
    role: 'user' as const,
    content: '가'.repeat(3_500),
  }));
  const estimated = estimateContextTokens(long);
  const decided = route('안녕', { estimatedContextTokens: estimated });
  record(
    '(s) a real long history routes a greeting to opus by window-fit',
    estimated > 250_000 && decided.tier === 'opus' && decided.reason === 'window-fit',
    `${estimated} tokens → ${decided.tier}/${decided.reason}`,
  );
}

// ---------------------------------------------------------------------------

function main(): boolean {
  checkBaseTier();
  checkWordBoundaries();
  checkSticky();
  checkWindowFit();
  checkBudgetCap();
  checkCatalog();
  checkTierOfModelId();
  checkEstimate();

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed += 1;
    console.log(`[${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  const total = checks.length;
  console.log(
    `\nSPIKE-MODEL-ROUTER: ${failed === 0 ? `ALL PASS (${total}/${total})` : `${total - failed}/${total} passed, ${failed} FAILED`}\n`,
  );
  return failed === 0;
}

try {
  if (!main()) process.exitCode = 1;
} catch (e) {
  console.error('SPIKE-MODEL-ROUTER crashed:', e);
  process.exitCode = 1;
}

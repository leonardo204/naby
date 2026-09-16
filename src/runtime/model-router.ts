// src/runtime/model-router.ts
//
// WHICH MODEL ANSWERS THIS TURN, when the user asked for `auto`
// (specs/model-auto-routing.md §4.2–§4.4, milestone M1).
//
// THE PROBLEM IT SOLVES. With the model chip on `default` the SDK picks, and on
// this machine that pick is `claude-opus-5[1m]` — so a one-line greeting is
// answered by opus, and the weekly opus window is spent on turns that never
// needed it. `auto` asks naby to choose per turn instead. This file is the
// choice, and nothing else.
//
// WHY IT IS PURE (§2 principle 2). The obvious implementation asks a small model
// "is this hard?" — and spends, on every turn, part of what the routing was
// supposed to save, plus a round-trip of latency before the real answer starts.
// So the router gets no store, no clock, no catalog, no I/O and no model: it
// takes the signals the shell already holds at the moment it has to decide
// (§3: `turnText`, `planMode`, the routed stage, an estimate of the history) and
// returns a tier. Everything it cannot compute — the usage cache, the live
// catalog, the message list — is passed IN. That is also what makes the whole
// decision table testable by a spike with no account and no network.
//
// WHY IT LEANS UP, NOT DOWN (§2 principles 3 and 4). The two failure directions
// are not symmetric:
//
//   * Routing too HIGH costs some of a subscription window. It is visible in the
//     usage bar, and the answer is still right.
//   * Routing too LOW does not raise an error. A weaker model accepts the hard
//     task and returns a worse answer, confidently, and nobody can tell from the
//     outside that a routing decision caused it. The failure is SILENT.
//
// So every rule here is written with that asymmetry in mind, and since
// 2026-09-16 the asymmetry has a floor: THE MAIN TURN NEVER RUNS BELOW SONNET
// (see `MAIN_TURN_TIERS`). An ambiguous turn is `sonnet`, and nothing routes
// below sonnet. What the `quiet` clause still decides is the REASON — `chat` for
// a short, code-free, verb-free turn against `default` for everything else — so
// the chip can keep saying why sonnet answered.
//
// LENGTH IS A CEILING, NEVER A CRITERION (§4.2 rule 1, `deep-ask`; added the same
// day, after the same session). A SHORT turn can need the most expensive kind of
// thinking there is: "왜 이렇게 동작해?" is ten characters and the answer takes
// reading the code until the cause is found; "effectiveAgentModel 어디서 써?" is
// a search across two trees. Reading those as small talk because they are short
// is exactly the silent failure above. So what a turn ASKS decides the tier, and
// the 200-character limit only ever holds a turn DOWN to `chat` — it can no
// longer be the reason a turn is quiet. `DEEP_KEYWORDS` and `IDENTIFIER_RE` are
// the two signals that route up.
//
// ONE RULE ROUTES DOWN, AND IT IS KEYED ON THE SHAPE OF THE DELIVERABLE
// (`routine`, added 2026-09-16 after the same user read the routing log a third
// time). Everything above leans up; `ROUTINE_KEYWORDS` is the single content rule
// that moves a turn to sonnet on purpose. What it recognises is not a subject but
// a DELIVERABLE: a script, a batch or bulk operation over many items, a list, a
// survey, a summary, a rename, a translation. Those are finished work that a
// weaker model produces as well as a stronger one, and today they route to opus
// by accident — "스크립트 하나 만들어줘" and "build a batch script" carry a build
// verb, and "조사해줘" used to carry a deep word. That is the distinction between
// the two lists: `deep` is about WHAT IS ASKED (a cause, a comparison, a trace),
// `routine` about WHAT COMES BACK.
//
// IT LOSES TO EVERY STRONGER SIGNAL, which is what keeps a down-routing rule
// safe: plan mode, a design ask, a pasted code fence, a long brief and a deep
// question all beat it, so "스크립트 왜 실패해?" is still a diagnosis on opus and
// "스크립트 설계 검토해줘" is still a design turn on fable. It beats only the two
// signals that are weaker evidence than it is — the build verbs (a script request
// usually says `만들어` or `build`) and the two-path count (a rename names the
// files it renames) — plus full mode.
//
// THE COST IS ACCEPTED, NOT MINIMISED (§2 principle 3). "문제 없어", "설명 고마워"
// and "어떻게 지내" carry those words and will go to opus. They are greetings, the
// routing is wrong, and it is wrong in the direction that only costs part of a
// window. Trimming the lists to catch them would cost the turns the lists exist
// for — "오답을 줄이려고 목록을 키우지 않는다" cuts both ways, and the rule is the
// spec's: 애매하면 위로, 그리고 목록은 다듬지 않는다.
//
// THE TWO RULES THAT OVERRIDE THE TURN'S OWN CHARACTER work in opposite
// directions and are not symmetric either:
//
//   * `window-fit` moves to the NEAREST tier whose window is KNOWN to hold the
//     conversation, preferring the higher one when two are equally near. It
//     usually raises; the one lowering move it can make is fable → opus, when
//     fable's window is unknown (no catalog: the alias measures 200k) and opus's
//     is not. That is not a cost decision — a model whose window cannot hold the
//     conversation is not a cheaper answer, it is a failed turn (§2 principle 4).
//     An UNKNOWN window is therefore never treated as known to fit.
//   * `budget-cap` is the only one of the two that lowers to SAVE something, so
//     it is the only rule another rule may veto: it stands down whenever sonnet
//     is not known to hold the turn. (`routine` also lowers, but it is a reading
//     of the turn itself rather than of the budget, and it belongs to rule 1.)
//
// The shell owns everything around this: reading the usage cache and the
// catalog, calling `contextWindowFor`, putting `model_route` on the init event
// and logging the line (§4.5). This file only decides.

import { estimateTokens } from './compaction.js';
import type { RuntimeMessage } from './engine.js';
import type { GrowthStage } from './growth.js';

// ---------------------------------------------------------------------------
// The contract (§4.2)
// ---------------------------------------------------------------------------

/** The four tiers the app knows. NOT model ids — a tier becomes a concrete
 *  catalog value through `pickCatalogValue`, because which id serves a tier
 *  depends on the live catalog and the router must not know it.
 *
 *  `auto` picks the MAIN TURN's model from `MAIN_TURN_TIERS`, which is these
 *  minus `haiku`; haiku stays a tier here because subagents run on it, receipts
 *  are read back through `tierOfModelId`, and the chip labels it when the user
 *  pins it by hand. */
export type ModelTier = 'haiku' | 'sonnet' | 'opus' | 'fable';

/**
 * WHY this tier, as a code rather than a sentence.
 *
 * It travels to the client on the init event and is rendered there from
 * `modelSwitcher.route.<reason>` (§4.6), so the wording is the shell's and the
 * two languages are i18n's problem, not this file's. A model that changes
 * silently reads as a bug (§2 principle 5) — this is what stops it being silent.
 */
export type RouteReason =
  | 'plan-mode'
  | 'design-ask'
  | 'build-ask'
  | 'deep-ask'
  | 'routine'
  | 'full-mode'
  | 'chat'
  | 'default'
  | 'sticky'
  | 'window-fit'
  | 'budget-cap';

/**
 * Everything the decision is allowed to depend on.
 *
 * All of it is already in the shell's hand at the point of the call (§3): no
 * field here costs a query, a model call or a file read to produce.
 */
export type RouteSignals = {
  /** This turn's user text (`turnText`). */
  text: string;
  /** `@naby` full mode — the persona is driving tools, not just answering. */
  fullMode: boolean;
  /** Growth stage of whoever answers. Absent when no agent is routed. */
  stage?: GrowthStage;
  /** Plan mode (read-only): the user asked for a plan before any edit. */
  planMode: boolean;
  /** Estimated occupancy of the context window — see `estimateContextTokens`.
   *  A LOWER BOUND, which is why the window rule carries a large margin. */
  estimatedContextTokens: number;
  /** Tier that answered the previous turn of this session, if it is known. */
  previousTier?: ModelTier;
  /** Window size per tier, or `undefined` where the size is not known. Filled by
   *  the caller with `windowsForTiers` so the router never reads the catalog. */
  windows: Record<ModelTier, number | undefined>;
  /**
   * Subscription limits, as percentages — the two the cap rule reads and no
   * others.
   *
   * OMITTED ENTIRELY when the usage cache is missing or stale-unusable (§4.5):
   * absent means "skip the budget rule", never "zero". EACH FIELD IS OPTIONAL
   * TOO, for the same reason one level down — `utilizationPercent` is optional
   * on the upstream limit rows, so a cache can be fresh and still not say how
   * full the opus window is. The cap is a helper that acts only on a number it
   * was actually given; a missing percentage is not a low one.
   */
  usage?: {
    fiveHourPct?: number;
    opusPct?: number;
  };
};

/** What the router answers: the tier, and the last rule that set it. */
export type RouteDecision = { tier: ModelTier; reason: RouteReason };

// ---------------------------------------------------------------------------
// Thresholds — every number the rules key on, named and exported
// ---------------------------------------------------------------------------

/**
 * Longest a turn may be and still be read as small talk (§4.2 rule 1, `chat`).
 *
 * 200 characters is roughly two Korean sentences. It used to be the threshold
 * that sent a turn down to the weakest model; since the main turn's floor is
 * sonnet it only picks the REASON (`chat` rather than `default`), which is what
 * the chip shows. Left low anyway: a reason that is wrong is a label nobody can
 * trust, and the number is the spec's (§4.2).
 */
export const CHAT_MAX_CHARS = 200;

/** Past this length a turn is treated as work regardless of its verbs (§4.2
 *  rule 1, `build-ask`). Nobody writes 1,200 characters to say hello; a pasted
 *  stack trace or a long requirement list is a build turn even with no verb we
 *  happen to recognise. */
export const BUILD_MIN_CHARS = 1_200;

/** How many file paths make a turn a build turn. Two, not one: "look at
 *  src/runtime/engine.ts" is a question, while a turn naming two files is
 *  almost always asking for a change across them. */
export const BUILD_MIN_PATHS = 2;

/**
 * Above this occupancy a session STICKS to the tier that answered it last
 * (§4.2 rule 2).
 *
 * Every turn builds a fresh `query()` and re-sends the whole history, and the
 * prompt cache is per model — so alternating models in a large conversation
 * throws the cache away twice and burns the 5-hour window faster than the
 * cheaper model saves. 40k is where the re-send stops being negligible. Below
 * it, the router is free to move every turn; above it, the session settles.
 */
export const STICKY_MIN_TOKENS = 40_000;

/** Margin on the occupancy estimate before a window counts as big enough
 *  (§4.2 rule 3). The estimate is a lower bound built from character counts, so
 *  the margin is multiplicative… */
export const WINDOW_FIT_MULTIPLIER = 1.5;

/** …plus a flat reserve for the answer itself and for what this turn will add. */
export const WINDOW_FIT_HEADROOM_TOKENS = 20_000;

/** At or above this percentage of a subscription window, opus and fable give way
 *  to sonnet (§4.2 rule 4) — unless the window rule forbids it. */
export const BUDGET_CAP_PCT = 90;

/** Share of the context window the system prompt, tool schemas and injected
 *  memory occupy before the conversation is counted at all (§4.4). The only
 *  number `estimateContextTokens` adds of its own — the chars-per-token rule
 *  belongs to `compaction.ts` and is imported, not restated. */
export const SYSTEM_PROMPT_TOKENS = 8_000;

// ---------------------------------------------------------------------------
// Keywords — Korean and English, matched as lowercase substrings (§4.2)
// ---------------------------------------------------------------------------

/**
 * Verbs that make a turn a DESIGN turn → fable.
 *
 * TWO MATCHING MODES, ONE LIST, decided by the entry's own alphabet — see
 * `containsKeyword`. Korean entries match as SUBSTRINGS because Korean attaches
 * particles and endings without a space: "설계해줘", "검토 좀" and "설계대로" all
 * have to hit `설계`/`검토`, and there is no boundary to anchor to. Latin entries
 * match WHOLE WORDS, because a substring rule there is simply wrong: "explain"
 * contains `plan`, "specific" and "inspect" contain `spec`, "especially"
 * contains `special`… — every one of those would send an ordinary question to
 * the design tier, which is the one misroute that is sideways rather than
 * upward, and therefore the one the "leaning up is safe" argument does NOT cover.
 *
 * INFLECTIONS ARE SPELLED OUT rather than stemmed. A stemmer is a dependency and
 * a second set of surprises; the handful of forms people actually type is
 * shorter than the code that would derive them. The list stays deliberately
 * small either way: "오답을 줄이려고 목록을 키우지 않는다. 애매하면 sonnet이다."
 */
export const DESIGN_KEYWORDS: readonly string[] = [
  '설계',
  '스펙',
  '아키텍처',
  '계획서',
  '전략',
  '리뷰',
  '검토',
  'design',
  'designs',
  'designing',
  'spec',
  'specs',
  'architecture',
  'architectures',
  'plan',
  'plans',
  'planning',
  'review',
  'reviews',
  'reviewing',
];

/** Verbs that make a turn a BUILD turn → opus. Checked after the design list,
 *  and their mere PRESENCE cancels a design match (§4.2 rule 1): "설계대로
 *  구현해줘" is a build turn that mentions design. Same two matching modes —
 *  without the word boundary, `test` would fire on "latest" and `fix` on
 *  "prefix". */
export const BUILD_KEYWORDS: readonly string[] = [
  '구현',
  '수정',
  '고쳐',
  '리팩터',
  '버그',
  '테스트',
  '만들어',
  'implement',
  'implements',
  'implementing',
  'fix',
  'fixes',
  'fixing',
  'refactor',
  'refactors',
  'refactoring',
  'debug',
  'debugs',
  'debugging',
  'build',
  'builds',
  'building',
  'test',
  'tests',
  'testing',
];

/**
 * Words that make a turn a DEEP turn → opus, however short it is (§4.2 rule 1,
 * `deep-ask`).
 *
 * WHAT THEY HAVE IN COMMON is not difficulty but SHAPE: every one of them asks
 * for a cause, a comparison, a trace or a judgement, and none of those can be
 * answered out of the turn's own text. The answer is reached by reading
 * something — the code, the history, the two options — and that is the work a
 * weaker model does worst and hides best. Checked after design, so "이 설계 왜
 * 이래?" stays a design turn on the tier above; and checked after the fence and
 * the length ceiling, so a turn that PASTED its code is a build turn whatever it
 * asks about it.
 *
 * IT OUTRANKS THE BUILD VERBS, since `routine` was added (2026-09-16), and that
 * reordering is deliberate rather than incidental: `routine` has to beat the
 * build verbs (a script request usually says `만들어` or `build`) and `deep` has to
 * beat `routine` ("스크립트 왜 실패해?" is a diagnosis, not a script), so the two
 * constraints together put the verbs last. The visible consequence is that "why
 * does the build fail" is now labelled `deep-ask` rather than `build-ask` — the
 * same opus turn, named after the question instead of the noun in it.
 *
 * SOME ENTRIES ARE PHRASES, and one is hyphenated, which the single-token rule
 * of `containsKeyword` could not have matched — see the third branch there. Bare
 * `how` is deliberately NOT on the list: "how are you" is small talk, "how does
 * it work" is not, and the difference is the next word. Everything else is the
 * same two matching modes as the lists above.
 *
 * THE LIST IS WIDE ON PURPOSE and is not tuned against its false positives (§2
 * principle 3). `문제`, `설명` and `어떻게` will catch "문제 없어", "설명 고마워"
 * and "어떻게 지내" — greetings answered by opus, at the price of part of a
 * window. The turns on the other side of that trade are the ones this whole
 * branch exists for.
 */
export const DEEP_KEYWORDS: readonly string[] = [
  '왜',
  '원인',
  '이유',
  '분석',
  '비교',
  '차이',
  '장단점',
  '트레이드오프',
  '추적',
  '파악',
  '설명',
  '평가',
  '판단',
  '추천',
  '근거',
  '영향',
  '어떻게',
  '어디',
  '문제',
  '에러',
  '오류',
  '실패',
  'why',
  'analyze',
  'analyse',
  'analysis',
  'compare',
  'comparison',
  'difference',
  'differences',
  'tradeoff',
  'tradeoffs',
  'trade-off',
  'trade-offs',
  'investigate',
  'trace',
  'explain',
  'evaluate',
  'recommend',
  'which',
  'where',
  'cause',
  'causes',
  'fails',
  'failing',
  'broken',
  'wrong',
  'understand',
  'error',
  'errors',
  // Phrases, because bare `how` is a greeting as often as it is a question.
  'how does',
  'how do',
  'how is',
  'how come',
  'how would',
  'how should',
  'how can',
];

/**
 * Words that make a turn a ROUTINE turn → sonnet (2026-09-16). The one content
 * rule in this file that routes DOWN.
 *
 * WHAT THEY HAVE IN COMMON is the SHAPE OF THE DELIVERABLE, not the subject and
 * not the difficulty: a script, a batch or bulk pass over many items, a list, a
 * survey of where something is used, a summary, a rename, a translation, a
 * count. Each one is finished work whose correctness is visible the moment it
 * comes back — you run the script, you read the list — which is exactly the case
 * where a weaker model's mistake is NOT the silent kind this file's header is
 * about. That is why the down-routing rule is allowed to exist at all, and why it
 * is keyed here and not on length or on politeness.
 *
 * THE COMPARISON THAT DEFINES IT is with `DEEP_KEYWORDS`: deep is about WHAT IS
 * ASKED (a cause, a comparison, a trace, a judgement), routine about WHAT COMES
 * BACK. `조사`, `찾아` and `정리` MOVED HERE FROM THE DEEP LIST the day this was
 * added — "어디서 쓰는지 조사해줘" is a survey that produces a list, not a
 * diagnosis — while 왜·원인·이유·분석·비교·차이·추적·어디·설명 stayed where they
 * are. When a turn carries both, deep wins: "스크립트 왜 실패해?" is a diagnosis
 * that happens to mention a script.
 *
 * WORDS DELIBERATELY LEFT OUT, because they are the everyday vocabulary of real
 * code work and would drag ordinary engineering down a tier: run, update, find,
 * move, copy, format, search, list. "update the auth flow to use refresh tokens"
 * is not a routine turn, and `update` on this list is all it would take to make
 * it one. The asymmetry from the header still applies to every entry here — a
 * wrong `routine` is the SILENT failure, not the visible one — so this list is
 * the one place in the file where the rule is "when in doubt, leave it out".
 *
 * Same two matching modes as the lists above: Korean entries are substrings,
 * single Latin entries are whole words, and `one-off` and `clean up` are phrases
 * (see `containsKeyword`).
 */
export const ROUTINE_KEYWORDS: readonly string[] = [
  '스크립트',
  '배치',
  '일괄',
  '조사',
  '목록',
  '나열',
  '정리',
  '요약',
  '번역',
  '변환',
  '리네임',
  '이름 바꿔',
  '이름을 바꿔',
  '추출',
  '파싱',
  '세어',
  '찾아',
  'script',
  'scripts',
  'batch',
  'bulk',
  'one-off',
  'cron',
  'boilerplate',
  'scaffold',
  'survey',
  'inventory',
  'summarize',
  'summarise',
  'summary',
  'translate',
  'convert',
  'conversion',
  'rename',
  'enumerate',
  'extract',
  'parse',
  'count',
  'lint',
  'clean up',
  'cleanup',
];

// ---------------------------------------------------------------------------
// Tier ordering
// ---------------------------------------------------------------------------

/**
 * THE TOTAL ORDER over tiers: haiku < sonnet < opus < fable.
 *
 * The order is the spec's, stated there in those words (§4.2), and this is the
 * executable copy of it — not a ranking invented here. Two rules measure with it
 * and neither means anything without it: sticky's "lower than previousTier" and
 * window-fit's "nearest fitting tier".
 *
 * WHY THE SPEC PUTS FABLE AT THE TOP rather than beside opus, recorded here
 * because the rules below read as arbitrary without the reasoning: what decides
 * the place is what a move ALONG the order costs. The order is not "how smart"
 * but "how much of the turn we are
 * willing to spend", and the design tier is the most expensive kind of turn to
 * get wrong: a design answer that is subtly shallow is acted on for days. Placing
 * it above opus means STICKY never demotes a design session, and `budget-cap` is
 * explicit when it does. `window-fit` is the exception, and an honest one: with
 * no catalog the fable alias measures 200k, so a long design conversation is
 * moved DOWN one place to opus — the only tier we then know can hold it.
 */
export const TIER_ORDER: readonly ModelTier[] = ['haiku', 'sonnet', 'opus', 'fable'];

/**
 * THE TIERS `auto` MAY PUT ON THE MAIN CONVERSATION (§2 principle 8). Sonnet is
 * the floor.
 *
 * WHY, dated because it was measured rather than assumed (2026-09-16): with the
 * chip on `auto`, short code-free turns were routed to haiku — and haiku
 * answering the MAIN conversation dropped the persona's voice and tone, and read
 * only fragments of the injected context. Both failures are the silent kind this
 * file's header is about: the answer arrives, it is fluent, and nothing in it
 * says a routing decision made it worse. The saving was never worth it, so the
 * main turn does not go there at all. Haiku is the SUBAGENT tier now (`explorer`
 * reads files in its own window, where voice and continuity do not apply), plus
 * a receipt value and an explicit pick by the user — and an explicit pick does
 * not come through this file.
 *
 * USED BY BOTH WINDOW-FIT BRANCHES, not just by `baseTier`. Sonnet and haiku
 * happen to share a 200k window today, so the window rule could not reach haiku
 * even when it iterated `TIER_ORDER` — but that is a coincidence of the current
 * catalog, and an invariant that holds by coincidence is one release away from
 * not holding. The floor lives in code.
 */
export const MAIN_TURN_TIERS: readonly ModelTier[] = ['sonnet', 'opus', 'fable'];

/** Position of a tier in `TIER_ORDER`. Higher is stronger/more expensive. */
export function tierRank(tier: ModelTier): number {
  return TIER_ORDER.indexOf(tier);
}

// ---------------------------------------------------------------------------
// Text shape
// ---------------------------------------------------------------------------

/** Fenced code blocks, closed or left open at the end of the message. */
const FENCE_RE = /```[\s\S]*?(?:```|$)/g;

/** Inline code. Counts as "code" for the `chat` rule, but does not by itself
 *  make a turn a build turn — people quote a function name while chatting. */
const INLINE_CODE_RE = /`[^`\n]+`/;

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;

/** A path with at least one separator: `src/runtime/engine.ts`, `shell/app`,
 *  `~/.naby/app.db`. Matched AFTER URLs are removed so a link's own slashes
 *  cannot be read as two files. */
const SLASH_PATH_RE = /(?:[\w.@~-]+\/)+[\w.@-]+/g;

/** A bare filename, for the turns that name files without their directory.
 *  The extension list is closed on purpose: an open `\.\w+` rule reads "3.5초"
 *  and "v1.36.5" as files. */
const BARE_FILE_RE =
  /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|kt|c|h|cpp|cs|rb|php|swift|sql|sh|zsh|yml|yaml|toml|css|scss|html)\b/gi;

/** The text with fenced code taken out (§4.2: fences are excluded from keyword
 *  matching). Exported because the spike asserts on it directly. */
export function stripCodeFences(text: string): string {
  return text.replace(FENCE_RE, ' ');
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re);
  return m === null ? 0 : m.length;
}

/**
 * How many distinct file paths the text names, URLs excluded.
 *
 * The two patterns are counted over DISJOINT text: `src/runtime/engine.ts` ends
 * in something the bare-filename pattern also matches, and counting both would
 * make every single-path turn look like the two-path turn that means "change
 * these files". A path is counted once.
 */
function countPaths(text: string): number {
  const withoutUrls = text.replace(URL_RE, ' ');
  const slashPaths = countMatches(withoutUrls, SLASH_PATH_RE);
  const remainder = withoutUrls.replace(SLASH_PATH_RE, ' ');
  return slashPaths + countMatches(remainder, BARE_FILE_RE);
}

/** An entry written in the Latin alphabet, which is the one that gets word
 *  boundaries. Anything else (Korean, in practice) keeps substring matching. */
const LATIN_KEYWORD = /^[a-z]+$/;

/**
 * A Latin entry that is MORE THAN ONE TOKEN: a phrase (`how does`) or a
 * hyphenated compound (`trade-off`).
 *
 * It needs its own branch because neither existing one is right for it. The
 * word-set path cannot see it at all — `latinWords` splits on the very space or
 * hyphen the entry is built around, so `how does` would be looked up as one
 * "word" that the set can never contain. And falling through to the Korean
 * substring path would match "show does" and "retrade-offer": a boundaryless
 * rule on Latin text is the exact mistake `DESIGN_KEYWORDS` documents.
 */
const LATIN_PHRASE = /^[a-z]+(?:[\s-]+[a-z]+)+$/;

/** Compiled phrase matchers, one per entry, built once. The lists are module
 *  constants, so this map is bounded by them and never grows with traffic. */
const phrasePatterns = new Map<string, RegExp>();

/**
 * `\bhow\s+does\b` for `how does`, `\btrade-off\b` for `trade-off`.
 *
 * Runs of whitespace in the entry become `\s+` so a line break or a double space
 * between the two words still matches; everything else is escaped and literal.
 * NOT a `/g` regex: `.test` on a global regex carries `lastIndex` between calls,
 * which would make the second identical question of a session miss.
 */
function phrasePattern(keyword: string): RegExp {
  let pattern = phrasePatterns.get(keyword);
  if (pattern === undefined) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`\\b${escaped.replace(/\s+/g, '\\s+')}\\b`);
    phrasePatterns.set(keyword, pattern);
  }
  return pattern;
}

/**
 * A CODE IDENTIFIER WRITTEN IN PROSE — `effectiveAgentModel`, `turn_text`,
 * `store.getMessages`, `foo()`.
 *
 * Why it is a signal at all: naming a symbol is how someone asks about code
 * WITHOUT quoting any. "effectiveAgentModel 어디서 써?" has no fence, no
 * backticks and no path, so every other clause of `quiet` holds and the turn
 * reads as small talk — while answering it means searching two trees. It only
 * ever DISQUALIFIES a turn from `chat`; on its own it lands on sonnet/`default`,
 * because a name by itself is as often "what is this" as it is a deep question.
 *
 * FOUR SHAPES, and the boundaries matter more than the shapes: camelCase needs a
 * lower-then-upper run, `snake_case` needs the underscore, member access and a
 * call need NO WHITESPACE around the dot or before the parens — which is what
 * keeps an ordinary sentence out ("done. Next" has a space after the dot, "안녕."
 * has no Latin letter after it). "e.g." matches, and that is tolerated: it costs
 * one reason code on a turn that was heading for sonnet either way.
 *
 * TESTED AGAINST CASED TEXT, never the lowercased `prose` — `effectiveagentmodel`
 * cannot match a camelCase pattern, so testing the lowered copy would silently
 * make this rule dead. URLs are stripped first because a host name is `a.b` in
 * every other respect, and paths are already counted by `countPaths`.
 */
export const IDENTIFIER_RE =
  /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[a-z0-9]+_[a-z0-9_]+\b|\b[A-Za-z_][\w]*\.[A-Za-z_][\w]*\b|\b[A-Za-z_][\w]*\(\)/;

/** The text as a set of Latin WORDS. Everything that is not an ASCII letter or
 *  digit separates, so Korean text simply produces no Latin words — which is
 *  correct: those keywords are matched the other way. */
function latinWords(lowercased: string): Set<string> {
  const set = new Set<string>();
  for (const word of lowercased.split(/[^a-z0-9]+/)) {
    if (word !== '') set.add(word);
  }
  return set;
}

/**
 * Does the text contain any of these keywords, each matched the way its own
 * alphabet requires (see `DESIGN_KEYWORDS`)?
 *
 * THREE BRANCHES, in narrowing order: a single Latin token is looked up in the
 * word set, a multi-token Latin entry is matched by its own boundary-anchored
 * regex (`LATIN_PHRASE`), and anything else — Korean, in practice — keeps
 * substring matching. The phrase branch is checked BEFORE the fallthrough on
 * purpose: `how does` fails the single-token test, and letting it reach the
 * substring path would match "show does".
 *
 * `text` is expected to be lowercased and fence-stripped already; the router
 * does both once per turn. Exported so the spike can assert the matching rule
 * itself rather than only its effect on a tier.
 */
export function containsKeyword(text: string, keywords: readonly string[]): boolean {
  const lowered = text.toLowerCase();
  let words: Set<string> | undefined;
  for (const keyword of keywords) {
    if (LATIN_KEYWORD.test(keyword)) {
      words ??= latinWords(lowered);
      if (words.has(keyword)) return true;
    } else if (LATIN_PHRASE.test(keyword)) {
      if (phrasePattern(keyword).test(lowered)) return true;
    } else if (lowered.includes(keyword)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rule 1 — the base tier (§4.2)
// ---------------------------------------------------------------------------

function baseTier(signals: RouteSignals): RouteDecision {
  // Plan mode is an explicit statement by the user — "plan first, do not edit" —
  // and outranks anything the text says, because the text of a plan-mode turn is
  // usually the build request itself.
  if (signals.planMode) return { tier: 'fable', reason: 'plan-mode' };

  const raw = signals.text ?? '';
  const unfenced = stripCodeFences(raw);
  const prose = unfenced.toLowerCase();
  // The same text WITH ITS CAPITALS, for the identifier rule only: a camelCase
  // pattern cannot match a lowercased copy. URLs go first so a host name is not
  // read as `a.b`; paths are counted separately by `countPaths`.
  const cased = unfenced.replace(URL_RE, ' ');
  const design = containsKeyword(prose, DESIGN_KEYWORDS);
  const build = containsKeyword(prose, BUILD_KEYWORDS);
  const deep = containsKeyword(prose, DEEP_KEYWORDS);
  const routine = containsKeyword(prose, ROUTINE_KEYWORDS);

  // Design wins ONLY with no build verb anywhere (§4.2 rule 1, second bullet).
  // Checked before the build conditions, in the spec's own order: a review turn
  // that pastes a fence is still a review turn.
  if (design && !build) return { tier: 'fable', reason: 'design-ask' };

  const fenced = FENCE_RE.test(raw);
  FENCE_RE.lastIndex = 0; // /g regexes are stateful; do not leak into the next call.
  // PASTED CODE AND A LONG BRIEF are the two build signals that outrank
  // everything below, because neither is a claim about the words: a fence means
  // the user is handing over code to work on, and 1,200 characters of
  // requirements is work whatever verbs it happens to contain. Both beat
  // `routine`, so "이 스크립트 고쳐줘" with the script pasted under it is a build
  // turn — the shape of that deliverable is the file, not a fresh one-off.
  if (fenced || raw.length > BUILD_MIN_CHARS) {
    return { tier: 'opus', reason: 'build-ask' };
  }

  // A question whose answer has to be WORKED OUT — a cause, a comparison, a
  // trace — however short it is. Below design, because "이 설계 왜 이래?" is
  // already going somewhere at least as strong; ABOVE `routine`, because a
  // question about a script is not a request for one ("스크립트 왜 실패해?"); and
  // therefore above the build verbs too, since `routine` has to beat those.
  // "why does the build fail" is labelled `deep-ask` for that reason — the same
  // opus turn either way, named after the question rather than the noun in it.
  if (deep) return { tier: 'opus', reason: 'deep-ask' };

  // THE ONE RULE THAT ROUTES DOWN. A script, a batch pass, a survey, a rename:
  // finished work whose deliverable can be checked on sight, which is what makes
  // sonnet a safe answer here and nowhere else (`ROUTINE_KEYWORDS`). It is placed
  // under every stronger signal and over the three weaker ones it has to beat —
  // the build verbs (a script request usually says `만들어` or `build`), the
  // two-path count (a rename names its files), and full mode.
  if (routine) return { tier: 'sonnet', reason: 'routine' };

  // The build verbs, and the file count that means "change these files".
  if (build || countPaths(prose) >= BUILD_MIN_PATHS) {
    return { tier: 'opus', reason: 'build-ask' };
  }

  // A butterfly (or pupa) in full mode is about to drive several tool steps on
  // its own. That is the most expensive kind of mistake to make cheaply.
  if (signals.fullMode && (signals.stage === 'pupa' || signals.stage === 'butterfly')) {
    return { tier: 'opus', reason: 'full-mode' };
  }

  // Small talk: the turn that used to go down to haiku. It is sonnet now
  // (`MAIN_TURN_TIERS`), and every clause still has to hold — what they decide
  // is the REASON the chip shows, `chat` rather than `default`.
  //
  // THE LENGTH TEST IS A CEILING AMONG THESE, not a criterion of its own: a turn
  // is quiet only when it is short AND carries none of the signals. `!deep` and
  // `!routine` are already guaranteed by the rules above returning; they are
  // written out anyway because this conjunction is the definition of "quiet", and
  // a definition that relies on the order of the clauses above it breaks the day
  // one of them moves.
  const quiet =
    raw.length <= CHAT_MAX_CHARS &&
    !fenced &&
    !INLINE_CODE_RE.test(raw) &&
    countPaths(raw) === 0 &&
    countMatches(raw, URL_RE) === 0 &&
    !design &&
    !build &&
    !deep &&
    !routine &&
    !IDENTIFIER_RE.test(cased);
  if (quiet) return { tier: 'sonnet', reason: 'chat' };

  // Ambiguous is sonnet, by instruction.
  return { tier: 'sonnet', reason: 'default' };
}

// ---------------------------------------------------------------------------
// Rules 2–4
// ---------------------------------------------------------------------------

/** Tokens a tier's window must hold before it is allowed to answer (§4.2 rule 3). */
export function requiredWindow(estimatedContextTokens: number): number {
  return Math.round(
    Math.max(0, estimatedContextTokens) * WINDOW_FIT_MULTIPLIER + WINDOW_FIT_HEADROOM_TOKENS,
  );
}

/** KNOWN to hold the conversation. An unknown window answers `false`: this
 *  function is asked when the answer decides whether a turn can succeed, and an
 *  unverified window is not a fact (see `contextWindowFor`'s own contract). */
function fits(windows: RouteSignals['windows'], tier: ModelTier, required: number): boolean {
  const size = windows?.[tier];
  return typeof size === 'number' && size >= required;
}

/**
 * The decision (§4.2). Four rules, in order; each may overwrite what the last
 * one chose, and `reason` names the LAST rule that actually moved the tier.
 */
export function routeModelTier(signals: RouteSignals): RouteDecision {
  const base = baseTier(signals);
  let tier = base.tier;
  let reason = base.reason;

  // 2. STICKY — a big conversation keeps the model it has been talking to,
  //    when that model was the stronger one. Never used to move DOWN.
  const previous = signals.previousTier;
  if (
    previous !== undefined &&
    signals.estimatedContextTokens > STICKY_MIN_TOKENS &&
    tierRank(previous) > tierRank(tier)
  ) {
    tier = previous;
    reason = 'sticky';
  }

  // 3. WINDOW FIT — a tier whose window cannot hold the conversation is not a
  //    candidate at all, whatever the turn is about.
  const required = requiredWindow(signals.estimatedContextTokens);
  const windows = signals.windows ?? ({} as RouteSignals['windows']);
  if (!fits(windows, tier, required)) {
    // Candidates are the MAIN-TURN tiers only: a window is a reason to move, and
    // never a reason to put the main conversation on haiku (`MAIN_TURN_TIERS`).
    const fitting = MAIN_TURN_TIERS.filter((t) => fits(windows, t, required));
    if (fitting.length > 0) {
      // NEAREST in the order, and on a tie the HIGHER one — the move is forced
      // by the window, so it should change the character of the answer as little
      // as possible, and when two candidates are equally far away the stronger
      // one is the safer place to land (§2 principle 3).
      const chosen = tier;
      const nearest = fitting.reduce((best, t) => {
        const dBest = Math.abs(tierRank(best) - tierRank(chosen));
        const dT = Math.abs(tierRank(t) - tierRank(chosen));
        if (dT < dBest) return t;
        if (dT === dBest && tierRank(t) > tierRank(best)) return t;
        return best;
      }, fitting[0] as ModelTier);
      if (nearest !== tier) {
        tier = nearest;
        reason = 'window-fit';
      }
    } else {
      // NOTHING fits. The turn may well fail, but it fails least on the biggest
      // window we know of — among the MAIN-TURN tiers, because a turn that is
      // going to be tight is the last one to hand to the weakest model. The
      // current tier keeps its place on a tie, so a fable turn stays fable when
      // fable is already as large as anything known.
      const current = windows?.[tier];
      let best = tier;
      let bestSize = typeof current === 'number' ? current : -1;
      for (const t of MAIN_TURN_TIERS) {
        const size = windows?.[t];
        if (typeof size === 'number' && size > bestSize) {
          best = t;
          bestSize = size;
        }
      }
      if (best !== tier) {
        tier = best;
        reason = 'window-fit';
      }
    }
  }

  // 4. BUDGET CAP — the only MODIFIER that lowers on purpose (rule 1's `routine`
  //    is the other rule that can, and it judges the turn, not the budget), so
  //    the only one another rule may veto. Skipped entirely when no usage was
  //    passed (§4.5: a missing or unusable cache means "do not guess", not
  //    "nothing is used").
  const usage = signals.usage;
  if (usage !== undefined && (tier === 'opus' || tier === 'fable')) {
    const opusPct = usage.opusPct;
    const fiveHourPct = usage.fiveHourPct;
    const tight =
      (typeof opusPct === 'number' && opusPct >= BUDGET_CAP_PCT) ||
      (typeof fiveHourPct === 'number' && fiveHourPct >= BUDGET_CAP_PCT);
    // Lowering into a window that cannot hold the conversation trades a bill for
    // a failed turn. Spending a little more of the limit is the better trade
    // (§4.2 rule 4), so the cap applies only when sonnet is KNOWN to fit.
    if (tight && fits(windows, 'sonnet', required)) {
      tier = 'sonnet';
      reason = 'budget-cap';
    }
  }

  return { tier, reason };
}

// ---------------------------------------------------------------------------
// Tier -> catalog value (§4.3)
// ---------------------------------------------------------------------------

/** One row of the live model catalog (`models.claude.cache`), narrowed to the
 *  two fields this file reads. */
export type CatalogRow = { value: string; resolvedModel?: string };

/** The catalog value that names the 1M opus tier. */
export const OPUS_1M_VALUE = 'opus[1m]';

/** Live fable rows are concrete ids (`claude-fable-5-1[1m]`), not the alias. */
export const FABLE_VALUE_PREFIX = 'claude-fable';

/**
 * The value to send to the SDK for a tier (§4.3).
 *
 * OPUS IS `opus[1m]`, WITH OR WITHOUT A CATALOG. Today's `default` resolves to
 * exactly that id (`resolvedModel` on the cached row), so turning `auto` on must
 * not quietly shrink the window from 1M to 200k — a downgrade the user never
 * asked for and could not see. The bare alias `opus` is a 200k window as far as
 * `contextWindowFor` can tell, which makes it the wrong fallback: it would make
 * opus ineligible for exactly the long conversations opus exists to hold. The
 * live row for opus carries this same string, so the catalog lookup below is a
 * confirmation rather than a choice.
 *
 * FABLE FALLS BACK TO THE PLAIN ALIAS, deliberately unlike opus. Live fable rows
 * are concrete ids (`claude-fable-5-1[1m]`), and no `fable[1m]` alias is known to
 * be accepted — inventing one to win a window would be a guess sent to a
 * provider. The honest consequence, on a machine whose catalog cache is empty:
 * fable measures 200k, so in a conversation past that size `window-fit` moves a
 * design turn to opus. That is the correct outcome of the information we have,
 * not a bug to paper over.
 */
export function pickCatalogValue(
  tier: ModelTier,
  live: readonly CatalogRow[] | undefined,
): string {
  const rows = live ?? [];
  if (tier === 'opus') {
    const row = rows.find((r) => r?.value === OPUS_1M_VALUE);
    return row?.value ?? OPUS_1M_VALUE;
  }
  if (tier === 'fable') {
    const row = rows.find(
      (r) => typeof r?.value === 'string' && r.value.startsWith(FABLE_VALUE_PREFIX),
    );
    return row?.value ?? 'fable';
  }
  return tier;
}

/**
 * Window size per tier, for `RouteSignals.windows`.
 *
 * The indirection is the point: the caller passes `pickCatalogValue`-with-its-
 * catalog and `(value) => contextWindowFor('dev-claude', value)`, so the router
 * gets sizes without ever importing either the catalog cache or the window
 * table. On a live catalog this yields opus 1,000,000 / fable 1,000,000 /
 * sonnet 200,000 / haiku 200,000.
 */
export function windowsForTiers(
  pick: (tier: ModelTier) => string,
  lookupWindow: (value: string) => number | undefined,
): Record<ModelTier, number | undefined> {
  return {
    haiku: lookupWindow(pick('haiku')),
    sonnet: lookupWindow(pick('sonnet')),
    opus: lookupWindow(pick('opus')),
    fable: lookupWindow(pick('fable')),
  };
}

// ---------------------------------------------------------------------------
// Reading a tier back off a model id (§4.4)
// ---------------------------------------------------------------------------

/**
 * The tier a RESOLVED model id belongs to, or `undefined` when it names nothing
 * we route between.
 *
 * This is how `previousTier` is recovered: the last dev-claude row of
 * `store.listUsage(sessionId)` carries the id the run actually served
 * (`claude-opus-5[1m]`, `claude-haiku-4-5-20251001`), not the alias we asked
 * for. Aliases and the bracketed catalog values are accepted too, so the same
 * function reads a request and a receipt.
 *
 * `undefined` for anything else — including `default`, which names whatever the
 * sign-in resolves and therefore names no tier. Guessing here would make the
 * sticky rule hold a tier nobody was on.
 */
export function tierOfModelId(id: string | undefined): ModelTier | undefined {
  const raw = (id ?? '').trim().toLowerCase();
  if (raw === '') return undefined;
  // Drop a trailing tier suffix so `opus[1m]` reads as the alias it is.
  const bare = raw.replace(/\[[^\]]*\]$/, '');
  if (bare === 'opus' || bare === 'sonnet' || bare === 'haiku' || bare === 'fable') {
    return bare;
  }
  // Fable BEFORE the generic families: its ids contain no other family name, but
  // ordering it first keeps the rule obvious next to context-window.ts's.
  if (bare.includes('claude-fable')) return 'fable';
  if (bare.includes('claude-opus')) return 'opus';
  if (bare.includes('claude-sonnet')) return 'sonnet';
  if (bare.includes('claude-haiku')) return 'haiku';
  return undefined;
}

// ---------------------------------------------------------------------------
// Occupancy estimate (§4.4)
// ---------------------------------------------------------------------------

/**
 * Anything `estimateContextTokens` can count: a bare string, or a message-shaped
 * object whose `content` may be a string or a block array.
 *
 * WIDE ON PURPOSE. The caller passes `store.getMessages(sessionId)`, whose
 * `RuntimeMessage` union includes a TOOL row with no `content` at all, so a
 * `{ content: string }` parameter would not accept the very array this exists
 * for. `role` is part of the shape for two reasons: it is what the tool row is
 * recognised BY (so the shared estimator can size its output properly), and its
 * presence gives that variant an overlapping property, which is what satisfies
 * TypeScript's weak-type check on an otherwise all-optional type.
 */
export type ContextTextSource =
  | string
  | { readonly role?: string; readonly content?: unknown };

/** Text of a `content` field that may be a string or a provider block array. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Block arrays: keep the text parts, drop images and tool payloads.
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') parts.push(block);
      else if (block !== null && typeof block === 'object') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
    return parts.join(' ');
  }
  return '';
}

/** Whether a row is already a store `tool` message, which the shared estimator
 *  sizes better than we could (it counts the tool name and the output). */
function isToolRow(item: ContextTextSource): item is RuntimeMessage {
  if (typeof item === 'string' || item === null || typeof item !== 'object') return false;
  const row = item as { role?: unknown; toolName?: unknown; output?: unknown };
  return (
    row.role === 'tool' &&
    typeof row.toolName === 'string' &&
    typeof (row.output as { content?: unknown } | undefined)?.content === 'string'
  );
}

/**
 * How full the context window probably is at the START of this turn (§4.4).
 *
 * THE ARITHMETIC IS NOT THIS FILE'S. Sizing a payload from its characters is
 * already owned by `compaction.ts` (session-context-management §2.3), down to
 * the 3.5 chars/token constant and the per-message envelope, and the one thing
 * worse than a crude estimate is two crude estimates that disagree — the
 * compaction path would fold against one number while the router judged windows
 * against another. So this reuses `estimateTokens` and adds exactly one thing
 * the router needs and compaction does not: the flat share of the window that is
 * already spent before the conversation is counted at all — system prompt, tool
 * schemas, injected memory and skills. It is why a fresh session reads as 8k
 * rather than 0.
 *
 * STILL A LOWER BOUND, openly. Images are not counted, the injected blocks vary,
 * and characters are not tokens. That is tolerable because of what the number is
 * FOR: the window rule multiplies it by 1.5 and adds 20k before comparing. An
 * estimate short by a third still lands on the right side of that comparison;
 * one that pretended to be exact would not be checked at all.
 */
export function estimateContextTokens(messages: readonly ContextTextSource[]): number {
  const rows: RuntimeMessage[] = [];
  for (const m of messages ?? []) {
    if (typeof m === 'string') {
      rows.push({ role: 'user', content: m });
    } else if (isToolRow(m)) {
      rows.push(m);
    } else {
      // Role is irrelevant to the size; `user` keeps the shape legal.
      rows.push({ role: 'user', content: textOf(m?.content) });
    }
  }
  return estimateTokens(rows) + SYSTEM_PROMPT_TOKENS;
}

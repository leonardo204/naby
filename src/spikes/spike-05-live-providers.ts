// SPIKE-05 — the LIVE metered path, end to end, on REAL provider keys.
//
// Every other spike stops at the provider registry's door: they hand the engine
// an already-constructed model and note "SPIKE-05 does the real thing." This is
// that spike. It reads real credentials from `.env`, builds real
// ProviderProfiles, resolves them through `makeModelResolver` (the ONE key-
// reading seam), and drives a real one-turn chat through the production
// `AiSdkEngine` + `runTurn` — the same path the app uses. A PASS proves the
// five-provider design actually answers, which unblocks F1-04 / F1-08's
// "≥2 providers reachable" acceptance bar.
//
// Providers exercised are whichever `.env` supplies (Azure OpenAI, Gemini).
// A provider with no creds present is SKIPPED (reported), not failed — the bar
// is "≥2 reachable," and the spike states exactly which it reached.
//
// SECRETS: keys are read from `.env` into the profile/credential and NEVER
// printed. Only provider ids, model ids, and the model's short reply are logged.
//
// Run with the cmux shim off PATH is NOT required here (no nested claude — this
// is pure HTTPS to the providers), but the .env must be loaded:
//   node --env-file=.env --import tsx src/spikes/spike-05-live-providers.ts
// (package.json wires `spike:05` to do exactly this.)

import { AiSdkEngine } from '../engines/ai-sdk-engine.js';
import type { EngineEvent, ModelSelection } from '../runtime/engine.js';
import { makeGate } from '../runtime/gate.js';
import { MemoryStore } from '../runtime/store/memory-store.js';
import { runTurn } from '../runtime/session.js';
import { buildToolset, Outbox } from '../runtime/tools.js';
import {
  apiKeyCredential,
  makeModelResolver,
  type ProviderCredential,
  type ProviderProfile,
} from '../providers/registry.js';

const PROMPT = 'Reply with exactly the word: PONG';
const EXPECT = 'PONG';

type Candidate = {
  present: boolean;
  profile?: ProviderProfile;
  credential?: ProviderCredential;
  note: string;
};

/** Azure OpenAI from AZURE_ENDPOINT / AZURE_DEPLOYMENT_NAME / AZURE_API_KEY.
 *
 * The endpoint in .env is the newer unified AI-Services shape
 * (`https://<resource>.services.ai.azure.com/openai/v1`), which the adapter's
 * `resourceName` form (→ `<resource>.openai.azure.com`) does NOT address. So we
 * pass the base URL straight through via `config.resource` only when it parses
 * to the classic shape; otherwise we hand the full endpoint to the adapter.
 * `makeModelResolver` reads `config`, so whatever shape we build here is what
 * the production path would build from stored settings. */
function azureCandidate(): Candidate {
  const endpoint = process.env.AZURE_ENDPOINT?.trim();
  const deployment = process.env.AZURE_DEPLOYMENT_NAME?.trim();
  const apiKey = process.env.AZURE_API_KEY?.trim();
  const apiVersion = process.env.AZURE_API_VERSION?.trim() || '2024-10-21';
  if (!endpoint || !deployment || !apiKey) {
    return { present: false, note: 'azure-openai: AZURE_* not all set — skipped' };
  }
  // Two shapes. The newer AI-Services endpoint ends in `/openai/v1` and is
  // OpenAI-compatible → drive via `config.baseURL`. A classic
  // `<res>.openai.azure.com` endpoint → parse the resource sub-domain.
  const isV1 = /\/openai\/v1\/?$/i.test(endpoint) || /services\.ai\.azure\.com/i.test(endpoint);
  const profile: ProviderProfile = {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    kind: 'azure-openai',
    config: isV1
      ? { kind: 'azure-openai', deployment, baseURL: endpoint }
      : {
          kind: 'azure-openai',
          deployment,
          apiVersion,
          resource: endpoint.match(/^https:\/\/([^.]+)\./i)?.[1] ?? '',
        },
    model: deployment, // azure quirk: model id IS the deployment name
    credentialRef: 'azure-openai',
  };
  return {
    present: true,
    profile,
    credential: apiKeyCredential(apiKey),
    note: isV1
      ? `azure-openai: v1 endpoint, deployment=${deployment}`
      : `azure-openai: classic resource, deployment=${deployment} apiVersion=${apiVersion}`,
  };
}

/** Gemini from GEMINI_API_KEY. */
function geminiCandidate(): Candidate {
  const apiKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) return { present: false, note: 'google: GEMINI_API_KEY not set — skipped' };
  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
  const profile: ProviderProfile = {
    id: 'google',
    label: 'Gemini',
    kind: 'google',
    config: { kind: 'google' },
    model,
    credentialRef: 'google',
  };
  return {
    present: true,
    profile,
    credential: apiKeyCredential(apiKey),
    note: `google: model=${model}`,
  };
}

function textOf(events: EngineEvent[]): string {
  return events
    .filter((e): e is Extract<EngineEvent, { kind: 'text' }> => e.kind === 'text' && e.role === 'assistant')
    .map((e) => e.text)
    .join('');
}

async function runOne(cand: Candidate): Promise<boolean> {
  const profile = cand.profile!;
  const store = new MemoryStore();
  const outbox = new Outbox();
  const { toolSchemas, executors } = buildToolset(outbox);
  // The ONE key-reading seam — exactly what the app uses.
  const resolveModel = makeModelResolver([profile], async () => cand.credential!);
  const engine = new AiSdkEngine({
    resolveModel: (sel) => resolveModel(sel.providerId, sel.model),
    maxSteps: 2,
  });
  const gate = makeGate(() => ({ behavior: 'allow' }));
  const model: ModelSelection = { providerId: profile.id, model: profile.model };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45_000);
  let events: EngineEvent[] = [];
  let err: string | null = null;
  try {
    events = await runTurn({
      engine,
      store,
      sessionId: `spike05-${profile.id}`,
      model,
      userText: PROMPT,
      toolSchemas,
      executors,
      gate: gate.gate,
      signal: ac.signal,
    });
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }

  const reply = textOf(events).trim();
  const result = events.find((e) => e.kind === 'result') as
    | Extract<EngineEvent, { kind: 'result' }>
    | undefined;
  const errorEv = events.find((e) => e.kind === 'error') as
    | Extract<EngineEvent, { kind: 'error' }>
    | undefined;

  const ok = !err && !errorEv && reply.toUpperCase().includes(EXPECT);
  console.log(`\n--- ${profile.id} (${profile.label}) ---`);
  console.log(`  ${cand.note}`);
  if (ok) {
    const u = result?.usage;
    console.log(`  [PASS] live reply: ${JSON.stringify(reply.slice(0, 40))}`);
    console.log(
      `  usage: in=${u?.inputTokens ?? '?'} out=${u?.outputTokens ?? '?'} cached=${u?.cachedInputTokens ?? '?'}`,
    );
  } else {
    console.log(`  [FAIL] reply=${JSON.stringify(reply.slice(0, 80))}`);
    if (err) console.log(`         threw: ${err.slice(0, 300)}`);
    if (errorEv) console.log(`         error event: ${errorEv.message.slice(0, 300)}`);
  }
  return ok;
}

async function main(): Promise<void> {
  console.log('=== SPIKE-05 — live metered path on real provider keys ===');
  const candidates = [azureCandidate(), geminiCandidate()];
  const present = candidates.filter((c) => c.present);
  const skipped = candidates.filter((c) => !c.present);
  for (const s of skipped) console.log(`[SKIP] ${s.note}`);

  if (present.length < 2) {
    console.log(
      `\nOnly ${present.length} provider(s) have credentials in .env — the "≥2 providers" bar needs 2.`,
    );
    // Still run what we have, but the overall bar is not met.
  }

  let passed = 0;
  for (const c of present) {
    if (await runOne(c)) passed += 1;
  }

  console.log(`\n=== SPIKE-05: ${passed}/${present.length} live providers answered ===`);
  const barMet = passed >= 2;
  console.log(barMet ? 'F1-04/F1-08 "≥2 providers reachable" bar: MET' : 'bar NOT met (need ≥2 live)');
  process.exit(barMet ? 0 : 1);
}

void main().catch((e: unknown) => {
  console.error('spike-05 crashed:', e);
  process.exit(2);
});

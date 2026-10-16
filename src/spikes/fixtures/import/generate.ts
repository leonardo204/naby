// src/spikes/fixtures/import/generate.ts
//
// Regenerates the BINARY fixtures of spike-participant-import (the text ones are
// written by hand). Run: `npx tsx src/spikes/fixtures/import/generate.ts`.
// Deterministic — running it again produces identical bytes, which the spike
// checks so the committed PNGs can never drift from this script.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPng } from '../../../runtime/import/png.js';
import { buildZip } from '../../../runtime/zip.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The V3 card carried in `minji.v3.png` (and, for a V2 reader, a `chara`
 *  chunk with the V2 shape — a real V3 PNG carries both). */
export function minjiV3Card(): Record<string, unknown> {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Minji Kim',
      nickname: 'Minji',
      description: '{{char}} is a patient Korean tutor for {{user}}.',
      personality: 'Warm and precise.',
      scenario: '',
      first_mes: '{{user}}, 반가워요! 저는 {{char}}예요.',
      mes_example: '<START>\n{{user}}: Hi!\n{{char}}: 안녕하세요!',
      creator_notes: 'A Korean conversation tutor. Call her for Korean phrasing, honorifics and practice dialogues.',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      group_only_greetings: ['Hello, everyone!'],
      tags: ['tutor'],
      creator: 'naby-fixture',
      character_version: '3.0',
      creation_date: 1784000000,
      assets: [
        { type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' },
        { type: 'background', uri: 'https://example.invalid/bg.png', name: 'cafe', ext: 'png' },
      ],
      character_book: {
        entries: [
          {
            keys: ['busan'],
            content: '@@depth 4\n{{char}} grew up in Busan.',
            enabled: true,
            insertion_order: 1,
            use_regex: false,
            constant: false,
            name: 'Hometown',
          },
        ],
      },
      extensions: { 'naby-fixture': { note: 'unknown extension kept verbatim' } },
    },
  };
}

export function minjiV3Png(): Uint8Array {
  const card = minjiV3Card();
  const v2 = { spec: 'chara_card_v2', spec_version: '2.0', data: { ...(card.data as object), nickname: undefined } };
  return buildPng({
    width: 8,
    height: 8,
    rgb: [109, 74, 255],
    text: {
      chara: Buffer.from(JSON.stringify(v2), 'utf8').toString('base64'),
      ccv3: Buffer.from(JSON.stringify(card), 'utf8').toString('base64'),
    },
  });
}

/** A valid PNG with no card in it. */
export function noCardPng(): Uint8Array {
  return buildPng({ width: 2, height: 2, text: { Comment: 'just a picture' } });
}

/** A CHARX archive (zip) — refused until a later milestone. */
export function charx(): Uint8Array {
  return new Uint8Array(buildZip([{ name: 'card.json', data: JSON.stringify(minjiV3Card()), method: 0 }]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(here, 'minji.v3.png'), minjiV3Png());
  writeFileSync(join(here, 'broken-no-card.png'), noCardPng());
  writeFileSync(join(here, 'broken-card.charx'), charx());
  console.log('wrote minji.v3.png, broken-no-card.png, broken-card.charx');
}

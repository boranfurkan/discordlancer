// End-to-end check of the Tessl hand-off, on a test repo whose Tessl factory is on.
// It opens an issue exactly as /request-update's Approve button does (the bot's own
// GitHub service and issue text: issue first, then the `tessl` label), then waits for
// Tessl's pull request and reports it.
//
// Spends Tessl credits, so run it on purpose, not on every change:
//   npx tsx scripts/tessl-e2e.ts --repo boranfurkan/dl-test-tessl [--minutes 30]
//
// Setting up the test repo's factory is described in TOOLS.md.

import { TESSL_LABEL } from '../src/discord/commands/afterDelivery.js';
import { loadEnv, secretValues } from '../src/env.js';
import { registerSecrets } from '../src/log.js';
import { issueBody } from '../src/prompts/after-delivery.js';
import { createGitHub } from '../src/services/github.js';

const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const repo = arg('repo');
const minutes = Number(arg('minutes') ?? 30);
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('Usage: npx tsx scripts/tessl-e2e.ts --repo owner/name [--minutes 30]');
  process.exit(2);
}

const env = loadEnv();
registerSecrets(secretValues(env));
const github = createGitHub(env);
const headers = {
  Authorization: `Bearer ${env.GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'discordlancer-tessl-e2e',
};

const started = new Date();
const issue = await github.openIssue(
  repo,
  `Test change ${started.toISOString().slice(0, 16)}: make the Book button green`,
  issueBody(
    repo.split('/')[1]!,
    'Change the colour of the Book button (.book-button in styles.css) to green. Keep the white text and everything else as it is.',
    'Please make the Book button green.',
    1,
  ),
  [TESSL_LABEL],
);
console.log(`opened issue #${issue.number}: ${issue.url}`);

type Pull = { number: number; html_url: string; title: string; body: string | null; head: { ref: string }; created_at: string };
const deadline = Date.now() + minutes * 60_000;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  const response = await fetch(`https://api.github.com/repos/${repo}/pulls?state=all&per_page=20`, { headers });
  const pulls = (await response.json()) as Pull[];
  const pull = pulls.find(
    (candidate) =>
      new Date(candidate.created_at) >= started &&
      (candidate.head.ref.startsWith('tessl/') || (candidate.body ?? '').includes(`#${issue.number}`)),
  );
  if (pull) {
    console.log(`PASS: Tessl opened pull request #${pull.number} on ${pull.head.ref} after ${Math.round((Date.now() - started.getTime()) / 1000)} s`);
    console.log(pull.html_url);
    process.exit(0);
  }
  process.stdout.write('.');
}
console.log(`\nFAIL: no pull request within ${minutes} minutes. Check the run in Tessl (tessl schedule runs <loop id>).`);
process.exit(1);

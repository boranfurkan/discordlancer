// /review-repo about [repo] [zip]: Boran points the bot at an existing codebase (the
// client's current app, or one they referred to): a GitHub link, or a zip of the code
// for a private one. The bot reads it, writes reference notes, saves them, and opens a
// pull request adding them to this project's repo. See src/discord/references.ts.

import { SlashCommandBuilder } from 'discord.js';
import { log } from '../../log.js';
import { findSecret } from '../../mcp/updates.js';
import { GeminiError } from '../../services/gemini.js';
import { GitHubError, REVIEW_LIMITS, reviewRank, type RepoSnapshot } from '../../services/github.js';
import { ZipError } from '../../files/zip.js';
import { ensureOwnerChannel } from '../channels.js';
import { requireProject, UserError, type Command } from '../command.js';
import { OWNER_NAME } from '../guards.js';
import { parseRepoRef, referenceDoc, referenceSlug, reviewPost, reviewSnapshot, type ReviewSource } from '../references.js';
import { READ_STAGES } from '../files.js';
import { snapshotFromZip } from '../references.js';

const description = "Review an existing codebase (a GitHub link or a zip) and add notes on it to this project's repo";
const MAX_ZIP_BYTES = 25 * 1024 * 1024;

const running = new Set<string>();

function githubStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;
}

async function readGithub(ctx: Parameters<Command['execute']>[0]['ctx'], input: string, ownRepo: string): Promise<ReviewSource> {
  const ref = parseRepoRef(input);
  if (!ref) throw new UserError('That isn\'t a GitHub repo link. Use one like `https://github.com/owner/name` or `owner/name`.');
  const label = `${ref.owner}/${ref.name}`;
  if (label.toLowerCase() === ownRepo.toLowerCase()) throw new UserError("That's this project's own repo. `/sync-docs` keeps its docs current.");
  let snapshot: RepoSnapshot;
  try {
    snapshot = await ctx.github.readRepo(label, { ref: ref.branch, limits: REVIEW_LIMITS, rank: reviewRank });
  } catch (error) {
    const status = githubStatus(error);
    if (status === 404) {
      throw new UserError(
        `I can't see \`${label}\`${ref.branch ? ` (branch \`${ref.branch}\`)` : ''}. If it's private, the bot's GitHub token has no access to it: ask for a zip of the code and run this again with \`zip\`. The bot never needs the client's GitHub password.`,
      );
    }
    if (status === 403 || status === 429) throw new UserError('GitHub refused or limited the request just now. Try again in a few minutes.');
    if (error instanceof GitHubError) throw new UserError(error.message);
    throw error;
  }
  return { kind: 'github', label, url: `https://github.com/${label}${ref.branch ? `/tree/${ref.branch}` : ''}`, snapshot };
}

async function readUpload(attachment: { name: string; size: number; url: string; contentType: string | null }): Promise<ReviewSource> {
  if (!/\.zip$/i.test(attachment.name) && !/zip/.test(attachment.contentType ?? '')) throw new UserError('The `zip` option takes a .zip of the code.');
  if (attachment.size > MAX_ZIP_BYTES) throw new UserError('That zip is over 25 MB. Leave out node_modules, build folders and images, then zip it again.');
  const response = await fetch(attachment.url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new UserError("Couldn't download the zip from Discord. Try again.");
  let snapshot: RepoSnapshot;
  try {
    snapshot = snapshotFromZip(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    if (error instanceof ZipError) throw new UserError(`Couldn't open the zip (${error.message}).`);
    throw error;
  }
  const name = attachment.name.replace(/\.zip$/i, '');
  return { kind: 'zip', label: `upload/${referenceSlug(name) || 'code'}`, snapshot };
}

export const reviewRepo: Command = {
  name: 'review-repo',
  description,
  access: 'owner',
  where: 'project',
  stages: READ_STAGES,
  definition: new SlashCommandBuilder()
    .setName('review-repo')
    .setDescription(description)
    .addStringOption((option) => option.setName('about').setDescription("What it is and why it matters, e.g. \"the client's current app; we're rebuilding its booking flow\"").setRequired(true).setMaxLength(500))
    .addStringOption((option) => option.setName('repo').setDescription('A GitHub link or owner/name (public, or one the bot can see)').setMaxLength(300))
    .addAttachmentOption((option) => option.setName('zip').setDescription('Or: a .zip of the code, for a private repo'))
    .toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx } = run;
    const about = interaction.options.getString('about', true).trim();
    const repo = interaction.options.getString('repo')?.trim();
    const zip = interaction.options.getAttachment('zip');
    if (!repo === !zip) throw new UserError('Give either `repo` (a GitHub link) or `zip` (a .zip of the code), not both.');
    if (running.has(project.name)) throw new UserError('A review is already running for this project. It takes a few minutes.');
    running.add(project.name);
    try {
      await interaction.deferReply();
      const source = repo ? await readGithub(ctx, repo, project.repo) : await readUpload(zip!);
      if (source.snapshot.files.length === 0) throw new UserError("I found no code or docs I could read in it, so there's nothing to review.");

      let review;
      try {
        review = await reviewSnapshot(ctx, project, source, about, interaction.user.id);
      } catch (error) {
        if (error instanceof GeminiError) throw new UserError(`Couldn't review it: ${error.message}`);
        throw error;
      }

      // The notes go into the project's repo as a pull request, unless they look like they hold a secret.
      let pull: { url: string; number: number } | undefined;
      let note: string | undefined;
      const secret = findSecret(review.markdown);
      if (secret) {
        note = `The notes seem to contain ${secret}, so they weren't added to the repo. They're saved and used for the specs and answers.`;
        log.warn('repo review not committed: it looked like it held a secret', { project: project.name, repo: review.repo });
      } else {
        try {
          const branch = `discordlancer/reference-${referenceSlug(review.repo)}`;
          const commit = await ctx.github.commitToBranch(project.repo, branch, [{ path: review.doc_path, content: referenceDoc(review) }], `Reference notes on ${review.repo}\n\nAI-written by Discordlancer from a review of ${review.repo}.`);
          if (commit.changed) {
            pull = await ctx.github.upsertPull(
              project.repo,
              branch,
              `Reference notes: ${review.repo}`,
              [
                `Discordlancer reviewed \`${review.repo}\` and wrote these notes for this project.`,
                '',
                `**Why it matters:** ${about}`,
                '',
                `**Summary (AI):** ${review.summary}`,
                '',
                `${review.files_read} of ${review.files_listed} files read, not run. _AI-written (Gemini \`${review.model}\`, prompt \`${review.prompt_version}\`). ${OWNER_NAME} reviews it before merging; the agreed spec decides what gets built._`,
              ].join('\n'),
            );
          } else note = `The notes in the repo (\`${review.doc_path}\`) were already the same.`;
        } catch (error) {
          log.warn('could not commit repo review notes', { project: project.name, error });
          note = `The notes couldn't be added to the repo just now (${githubStatus(error) === 403 ? "the bot's GitHub token can't write to it" : 'GitHub error'}). They're saved and used for the specs and answers.`;
        }
      }

      await interaction.editReply({ content: reviewPost(review, pull, note), allowedMentions: { parse: [] } });
      if (pull) {
        const desk = await ensureOwnerChannel(interaction.guild, ctx.env.DISCORD_OWNER_ID).catch(() => undefined);
        await desk?.send(`Review **${project.name}**: reference notes on \`${review.repo}\` are in pull request #${pull.number}. ${pull.url}`).catch(() => undefined);
      }
    } finally {
      running.delete(project.name);
    }
  },
};

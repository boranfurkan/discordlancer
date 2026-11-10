// Words the bot says. Kept together so the tone stays the same everywhere.

import { clientMembers, type Project } from '../db/projects.js';
import type { Stage } from '../domain/stages.js';
import { OWNER_NAME } from './guards.js';

export const STAGE_LABEL: Record<Stage, string> = {
  created: 'Waiting for the client to join',
  joined: 'Talking about the project',
  specs_agreed: 'Specs agreed',
  quote_accepted: 'Quote accepted',
  paid: 'Paid',
  in_development: 'Being built',
  delivered: 'Delivered',
  support: 'Support',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

export const NEXT_STEP: Record<Stage, string> = {
  created: `${OWNER_NAME} sends the invite link to the client.`,
  joined: `Describe what you need here, with screenshots if they help. ${OWNER_NAME} then writes the specs with /create-specs.`,
  specs_agreed: `${OWNER_NAME} posts a quote with /quote.`,
  quote_accepted: 'The client declares their wallet with /set-payment-wallet, then pays with /pay.',
  paid: `${OWNER_NAME} starts building with /start-development.`,
  in_development: `Building. When it's ready, ${OWNER_NAME} marks it delivered with /confirm-delivery and the client confirms.`,
  delivered: 'Delivered. Small changes can be asked for with /request-update.',
  support: 'Small changes can be asked for with /request-update.',
  cancelled: 'This project was cancelled.',
  archived: 'This project is archived.',
};

/** Pings everyone on the client's side, or says "Client" if nobody has joined. */
export function clientMentions(project: Pick<Project, 'client_id' | 'client_ids'>): string {
  return clientMembers(project).map((id) => `<@${id}>`).join(' ') || 'Client';
}

/** For someone joining a project their team already has, with a team invite. */
export function teamWelcomeText(memberId: string, projectName: string, guideId?: string): string {
  return [
    `Welcome, <@${memberId}>! You've joined **${projectName}** with the rest of your team.`,
    `Everyone on your side can talk here, ask about the project with /ask, join calls, and agree specs, quotes and the delivery for your team. Earlier messages are above, and call notes, code changes and progress updates have their own threads.`,
    guideId ? `New here? <#${guideId}> explains each step and every command. Type /help at any time to see what you can do now.` : 'Type /help at any time to see what you can do.',
  ].join('\n');
}

export function welcomeText(clientId: string, guideId?: string): string {
  return [
    `Welcome, <@${clientId}>! This is your private project channel with ${OWNER_NAME}. Only the people on this project and the Discordlancer bot can see it. Need colleagues here too? Ask ${OWNER_NAME} for an invite for each of them.`,
    '',
    '**How it works**',
    "1. Tell us here what you need. Screenshots, links and files are all welcome.",
    `2. ${OWNER_NAME} turns the conversation into written specs with /create-specs, and you both agree them with /agree-specs.`,
    `3. ${OWNER_NAME} posts a quote with /quote, and you accept it with /accept-quote.`,
    '4. You pay in USDC on Solana with /pay. The bot checks the payment on chain by itself.',
    `5. ${OWNER_NAME} builds and delivers, and you confirm the delivery. While he builds, progress updates appear here.`,
    '',
    `**Questions** about the project, at any stage: /ask. The AI assistant answers here from this chat, the specs and the code, and ${OWNER_NAME} follows up on anything it can't answer or that needs his decision.`,
    '',
    `**Privacy:** the bot keeps a record of this project: the messages here (used to write the specs and answer questions), notes on the files and links you share (the bot reads each one once; the files stay in Discord), the commands you run, and payments. That gives you both a clear history. Specs, progress estimates and assistant answers are drafted with AI (Google Gemini) and marked as such; Gemini does not keep them. Progress updates are written by ${OWNER_NAME}'s AI coding assistant (Claude) while he works, and are marked as such too. Calls in the project's voice channel are recorded only if you agree each time (a button): ElevenLabs transcribes them (and any voice notes you share) and the bot then asks it to delete its copy; the bot keeps the transcript and a summary, not the audio.`,
    '',
    guideId ? `<#${guideId}> explains each step and every command. Type /help at any time to see what you can do now.` : 'Type /help at any time to see what you can do.',
  ].join('\n');
}

/** The default quote terms. Boran should review these; they are a business decision. */
export function quoteTerms(specVersion: number, amount: string, deadline: string): string[] {
  return [
    `Scope: what spec v${specVersion} describes. Anything beyond it needs a new quote.`,
    `Price: ${amount} USDC, paid in full on Solana before work starts.`,
    `Delivery: by ${deadline}, in a GitHub repo you have access to.`,
    'Ownership: the code is yours once the payment is confirmed.',
    "Fixes: anything that doesn't match the agreed spec is fixed at no extra cost. New features need a new quote.",
  ];
}

/** Discord messages are limited to 2,000 characters. */
export function fitMessage(text: string, limit = 1_950): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 20).trimEnd()}\n…(shortened)`;
}

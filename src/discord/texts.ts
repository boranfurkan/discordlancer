// Words the bot says. Kept together so the tone stays the same everywhere.

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

export function welcomeText(clientId: string): string {
  return [
    `Welcome, <@${clientId}>! This is your private project channel with ${OWNER_NAME}. Only the two of you and the Discordlancer bot can see it.`,
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
    `**Privacy:** the bot keeps a record of this project: the messages here (used to write the specs and answer questions), the commands you run, and payments. That gives you both a clear history. Specs, progress estimates and assistant answers are drafted with AI (Google Gemini) and marked as such; Gemini does not keep them. Progress updates are written by ${OWNER_NAME}'s AI coding assistant (Claude) while he works, and are marked as such too. Calls in the project's voice channel are recorded only if you agree each time (a button): ElevenLabs transcribes them and the bot then asks it to delete its copy; the bot keeps the transcript and a summary, not the audio.`,
    '',
    'Type /help at any time to see what you can do.',
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

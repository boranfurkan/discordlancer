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
  in_development: 'Building. The client can check progress with /status.',
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
    `5. ${OWNER_NAME} builds and delivers, and you confirm the delivery.`,
    '',
    `**Privacy:** the bot keeps a record of this project: the messages here (used to write the specs), the commands you run, and payments. That gives you both a clear history. Specs and progress estimates are drafted with AI (Google Gemini) and checked by ${OWNER_NAME}; Gemini does not keep them.`,
    '',
    'Type /help at any time to see what you can do.',
  ].join('\n');
}

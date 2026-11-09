// /set-payment-wallet and /wallet.

import { SlashCommandBuilder } from 'discord.js';
import { updateProject } from '../../db/projects.js';
import { isSolanaAddress, SYSTEM_PROGRAM } from '../../services/solana.js';
import { requireProject, UserError, type Command } from '../command.js';
import { OWNER_NAME } from '../guards.js';

const setDescription = 'Declare the Solana wallet you will pay from';

export const setPaymentWallet: Command = {
  name: 'set-payment-wallet',
  description: setDescription,
  access: 'everyone',
  where: 'project',
  stages: ['joined', 'specs_agreed', 'quote_accepted'],
  definition: new SlashCommandBuilder()
    .setName('set-payment-wallet')
    .setDescription(setDescription)
    .addStringOption((option) =>
      option.setName('address').setDescription("Your Solana wallet's address (not a token account)").setRequired(true),
    )
    .toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx, actor } = run;
    if (actor === 'owner') throw new UserError("The client declares their own wallet; that's the proof it's theirs.");
    const address = interaction.options.getString('address', true).trim();
    if (!isSolanaAddress(address)) throw new UserError("That isn't a Solana address. Copy it from your wallet app.");
    if (address === ctx.env.SOLANA_WALLET_ADDRESS) throw new UserError(`That's ${OWNER_NAME}'s receiving wallet. Use the wallet you'll pay from.`);
    await interaction.deferReply();

    let owner: string | null;
    try {
      owner = await ctx.solana.accountOwner(address);
    } catch {
      throw new UserError("Couldn't check that address right now. Please try again in a minute.");
    }
    if (owner !== null && owner !== SYSTEM_PROGRAM) {
      throw new UserError("That address looks like a token account or a program, not a wallet. Use your wallet's main address.");
    }

    await updateProject(
      ctx.db,
      project,
      { client_wallet: address },
      { actor, actorId: interaction.user.id, action: 'wallet.declared', outcome: 'ok', data: { address, previous: project.client_wallet ?? null } },
    );
    await interaction.editReply(
      [
        `<@${interaction.user.id}> declared their payment wallet: \`${address}\``,
        'Only USDC sent from this wallet is accepted for this project.',
        project.stage === 'quote_accepted' ? 'Next: pay with **/pay**.' : 'You can pay with /pay once a quote is accepted.',
      ].join('\n'),
    );
  },
};

const walletDescription = `Show ${OWNER_NAME}'s receiving wallet`;

export const wallet: Command = {
  name: 'wallet',
  description: walletDescription,
  access: 'everyone',
  where: 'project',
  definition: new SlashCommandBuilder().setName('wallet').setDescription(walletDescription).toJSON(),
  async execute(run) {
    const project = requireProject(run);
    await run.interaction.reply(
      [
        `${OWNER_NAME}'s receiving wallet: \`${run.ctx.env.SOLANA_WALLET_ADDRESS}\``,
        '**USDC on Solana only.** Other tokens, or USDC on another network, are not detected and may be lost.',
        project.client_wallet ? `Declared paying wallet: \`${project.client_wallet}\`` : 'No paying wallet declared yet (/set-payment-wallet).',
      ].join('\n'),
    );
  },
};

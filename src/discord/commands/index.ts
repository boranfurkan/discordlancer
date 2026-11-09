import type { Command } from '../command.js';
import { addGithub } from './addGithub.js';
import { archive, cancel } from './close.js';
import { confirmDelivery } from './delivery.js';
import { exportEvidence, report, touches } from './evidence.js';
import { help } from './help.js';
import { linkClient } from './linkClient.js';
import { newProject } from './newProject.js';
import { paid, pay, receipt, startDevelopment } from './pay.js';
import { projectInfo } from './project.js';
import { acceptQuote, quote } from './quote.js';
import { agreeSpecs, createSpecs } from './specs.js';
import { setPaymentWallet, wallet } from './wallet.js';

export const COMMANDS: readonly Command[] = [
  help,
  projectInfo,
  newProject,
  linkClient,
  addGithub,
  createSpecs,
  agreeSpecs,
  quote,
  acceptQuote,
  setPaymentWallet,
  wallet,
  pay,
  paid,
  receipt,
  startDevelopment,
  confirmDelivery,
  exportEvidence,
  report,
  touches,
  cancel,
  archive,
];

const names = COMMANDS.map((command) => command.name);
const duplicate = names.find((name, index) => names.indexOf(name) !== index);
if (duplicate) throw new Error(`Two commands are named ${duplicate}`);

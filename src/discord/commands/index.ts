import type { Command } from '../command.js';
import { addGithub } from './addGithub.js';
import { ask } from './ask.js';
import { call } from './call.js';
import { requestUpdate, status } from './afterDelivery.js';
import { archive, cancel } from './close.js';
import { confirmDelivery } from './delivery.js';
import { exportEvidence, report, touches } from './evidence.js';
import { help } from './help.js';
import { invoice } from './invoice.js';
import { teamInvite } from './invite.js';
import { linkClient } from './linkClient.js';
import { newProject } from './newProject.js';
import { paid, pay, receipt, startDevelopment } from './pay.js';
import { projectInfo } from './project.js';
import { readFiles } from './readFiles.js';
import { acceptQuote, quote } from './quote.js';
import { agreeSpecs, createSpecs } from './specs.js';
import { syncDocs } from './syncDocs.js';
import { setPaymentWallet, wallet } from './wallet.js';

export const COMMANDS: readonly Command[] = [
  help,
  projectInfo,
  newProject,
  teamInvite,
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
  invoice,
  startDevelopment,
  confirmDelivery,
  status,
  ask,
  call,
  readFiles,
  syncDocs,
  requestUpdate,
  exportEvidence,
  report,
  touches,
  cancel,
  archive,
];

const names = COMMANDS.map((command) => command.name);
const duplicate = names.find((name, index) => names.indexOf(name) !== index);
if (duplicate) throw new Error(`Two commands are named ${duplicate}`);

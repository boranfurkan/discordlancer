import type { Command } from '../command.js';
import { help } from './help.js';

export const COMMANDS: readonly Command[] = [help];

const names = COMMANDS.map((command) => command.name);
const duplicate = names.find((name, index) => names.indexOf(name) !== index);
if (duplicate) throw new Error(`Two commands are named ${duplicate}`);

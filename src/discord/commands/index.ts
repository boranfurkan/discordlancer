import type { Command } from '../command.js';
import { addGithub } from './addGithub.js';
import { archive, cancel } from './close.js';
import { help } from './help.js';
import { linkClient } from './linkClient.js';
import { newProject } from './newProject.js';
import { projectInfo } from './project.js';

export const COMMANDS: readonly Command[] = [help, projectInfo, newProject, linkClient, addGithub, cancel, archive];

const names = COMMANDS.map((command) => command.name);
const duplicate = names.find((name, index) => names.indexOf(name) !== index);
if (duplicate) throw new Error(`Two commands are named ${duplicate}`);

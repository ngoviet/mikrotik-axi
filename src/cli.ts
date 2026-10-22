import { runAxiCli, type AxiCliCommand } from "axi-sdk-js";
import { homeHeader, homeView } from "./commands/home.js";
import { defaultRuntime, type Runtime } from "./context.js";
import { COMMANDS, DESCRIPTION, topLevelHelp } from "./registry.js";
import { VERSION } from "./version.js";

export { DESCRIPTION };

export interface MainOptions {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
  runtime?: Runtime;
}

export async function main(options: MainOptions = {}): Promise<void> {
  const rt = options.runtime ?? defaultRuntime();
  const commands: Record<string, AxiCliCommand<undefined>> = {
    home: async (args) => ({ ...homeHeader(DESCRIPTION), ...(await homeView(args, rt)) }),
  };
  for (const [name, spec] of Object.entries(COMMANDS)) {
    if (spec.run) commands[name] = (args) => spec.run!(args, rt);
  }
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    ...(options.argv ? { argv: options.argv } : {}),
    ...(options.stdout ? { stdout: options.stdout } : {}),
    topLevelHelp: topLevelHelp(),
    getCommandHelp: (command) => COMMANDS[command]?.help,
    home: () => homeView([], rt),
    commands,
  });
}

import {startStack, stopStack} from './stack.ts';

export default async function globalSetup(): Promise<void> {
  await stopStack();
  const info = await startStack();
  process.stdout.write(`e2e stack: runtime ${info.baseUrl}, agent :${info.agentPort}, data ${info.dataDir}\n`);
}

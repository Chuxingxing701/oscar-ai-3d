import {stopStack} from './stack.ts';

export default async function globalTeardown(): Promise<void> {
  await stopStack();
}

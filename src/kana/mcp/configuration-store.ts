import {
  type KanaMcpActivationState,
  loadKanaMcpActivationState,
  parseKanaMcpActivationState,
  persistKanaMcpActivationState,
} from "./activation";
import { type KanaMcpConfig, loadKanaMcpConfig } from "./config";

export type KanaMcpConfigurationSource = {
  getConfig(): KanaMcpConfig;
  getActivationState(): KanaMcpActivationState;
};

export type KanaMcpConfigurationStore = KanaMcpConfigurationSource & {
  saveActivationState(state: KanaMcpActivationState): KanaMcpActivationState;
};

export function createKanaMcpConfigurationStore(
  env: NodeJS.ProcessEnv = process.env,
): KanaMcpConfigurationStore {
  const config = loadKanaMcpConfig(env);
  let activationState = loadKanaMcpActivationState(env);

  return {
    getConfig: () => structuredClone(config),
    getActivationState: () => structuredClone(activationState),
    saveActivationState(state) {
      const next = parseKanaMcpActivationState(state);
      persistKanaMcpActivationState(activationState, next, env);
      activationState = next;
      return structuredClone(activationState);
    },
  };
}

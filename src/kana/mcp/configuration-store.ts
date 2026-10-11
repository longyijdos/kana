import {
  type KanaMcpActivationState,
  loadKanaMcpActivationState,
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
    getConfig: () => config,
    getActivationState: () => activationState,
    saveActivationState(state) {
      persistKanaMcpActivationState(activationState, state, env);
      activationState = state;
      return activationState;
    },
  };
}

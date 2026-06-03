import type { ModelOptions, ModelProvider } from "../core/model";

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  register<TOptions extends ModelOptions = ModelOptions>(
    name: string,
    provider: ModelProvider<TOptions>,
  ): void {
    if (!name) {
      throw new Error("Provider name is required.");
    }

    this.providers.set(name, provider as ModelProvider);
  }

  get<TOptions extends ModelOptions = ModelOptions>(
    name: string,
  ): ModelProvider<TOptions> {
    const provider = this.providers.get(name);

    if (!provider) {
      throw new Error(`Provider "${name}" is not registered.`);
    }

    return provider as ModelProvider<TOptions>;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }
}

export const defaultProviderRegistry = new ProviderRegistry();

export function registerProvider<TOptions extends ModelOptions = ModelOptions>(
  name: string,
  provider: ModelProvider<TOptions>,
): void {
  defaultProviderRegistry.register(name, provider);
}

export function getProvider<TOptions extends ModelOptions = ModelOptions>(
  name: string,
): ModelProvider<TOptions> {
  return defaultProviderRegistry.get<TOptions>(name);
}

export function hasProvider(name: string): boolean {
  return defaultProviderRegistry.has(name);
}

export function listProviders(): string[] {
  return defaultProviderRegistry.list();
}

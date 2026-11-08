import { Injectable } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { STATIC_CONTEXT } from '@nestjs/core/injector/constants.js';

export interface LogContext {
  module: string | null;
  context?: string;
}

@Injectable()
export class LoggerContext {
  constructor(private readonly modules: ModulesContainer) {}

  resolve(inquirer: object | undefined): LogContext {
    if (!inquirer) {
      return { module: null };
    }

    const context = inquirer.constructor?.name;
    const candidates: LogContext[] = [];

    for (const module of this.modules.values()) {
      for (const wrapper of [...module.providers.values(), ...module.controllers.values()]) {
        if (wrapper.isAlias) {
          continue;
        }

        const owner = { module: module.metatype.name, context: String(wrapper.name) };

        // INQUIRER is the prototype instance during constructor resolution.
        if (wrapper.instance === inquirer) {
          return owner;
        }

        if (wrapper.metatype === inquirer.constructor) {
          candidates.push(owner);
        }
      }
    }

    return candidates.length === 1 ? candidates[0]! : { module: null, context };
  }

  bindConsumers(loggerToken: Function): void {
    for (const module of this.modules.values()) {
      for (const wrapper of [...module.providers.values(), ...module.controllers.values()]) {
        if (wrapper.isAlias) {
          continue;
        }

        for (const dependency of wrapper.getCtorMetadata() ?? []) {
          if (dependency.token !== loggerToken) {
            continue;
          }

          // Nest caches a transient dependency per concrete consumer wrapper ID.
          // Only inspect known direct dependencies; do not create resolutions.
          const host = dependency.getInstanceByInquirerId(STATIC_CONTEXT, wrapper.id);

          if (host.isResolved && host.instance) {
            host.instance.bindContext({
              module: module.metatype.name,
              context: String(wrapper.name),
            });
          }
        }
      }
    }
  }
}

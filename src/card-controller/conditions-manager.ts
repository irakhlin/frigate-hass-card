import { HassEntities } from 'home-assistant-js-websocket';
import merge from 'lodash-es/merge';
import { copyConfig } from '../config-mgmt';
import {
  FrigateCardCondition,
  frigateConditionalSchema,
  MicrophoneConditionState,
  OverrideConfigurationKey,
  RawFrigateCardConfig,
  ViewDisplayMode,
} from '../config/types';
import { CardConditionAPI } from './types';

interface ConditionState {
  view?: string;
  fullscreen?: boolean;
  expand?: boolean;
  camera?: string;
  state?: HassEntities;
  media_loaded?: boolean;
  displayMode?: ViewDisplayMode;
  triggered?: Set<string>;
  interaction?: boolean;
  microphone?: MicrophoneConditionState;
}

export class ConditionEvaluateRequestEvent extends Event {
  public condition: FrigateCardCondition;
  public evaluation?: boolean;

  constructor(condition: FrigateCardCondition, eventInitDict?: EventInit) {
    super('frigate-card:condition:evaluate', eventInitDict);
    this.condition = condition;
  }
}

/**
 * Evaluate whether a frigateCardCondition is met using an event to evaluate.
 * @returns A boolean indicating whether the condition is met.
 */
export function evaluateConditionViaEvent(
  element: HTMLElement,
  condition?: FrigateCardCondition,
): boolean {
  if (!condition) {
    return true;
  }

  const evaluateEvent = new ConditionEvaluateRequestEvent(condition, {
    bubbles: true,
    composed: true,
  });

  /* Special note on what's going on here:
   *
   * Some parts of the card (e.g. <frigate-card-elements>) may have arbitrary
   * complexity and layers (that this card doesn't control) between that master
   * element and the element that needs to evaluate the condition. In these
   * cases there's no clean way to pass state from the rest of card down through
   * these layers. Instead, an event is dispatched as a "request for evaluation"
   * (ConditionEvaluateRequestEvent) upwards which is caught by the outer card
   * and the evaluation result is added to the event object. Because event
   * propagation is handled synchronously, the result will be added to the event
   * before the flow proceeds.
   */
  element.dispatchEvent(evaluateEvent);
  return evaluateEvent.evaluation ?? false;
}

type RawOverrides = {
  conditions: FrigateCardCondition;
  overrides: RawFrigateCardConfig;
}[];

export function getOverriddenConfig(
  manager: Readonly<ConditionsManager>,
  config: Readonly<RawFrigateCardConfig>,
  configOverrides?: Readonly<RawOverrides>,
  stateOverrides?: Partial<ConditionState>,
): RawFrigateCardConfig {
  const output = copyConfig(config);
  let overridden = false;
  if (configOverrides) {
    for (const override of configOverrides) {
      if (manager.evaluateCondition(override.conditions, stateOverrides)) {
        merge(output, override.overrides);
        overridden = true;
      }
    }
  }
  // Attempt to return the same configuration object if it has not been
  // overridden (to reduce re-renders for a configuration that has not changed).
  return overridden ? output : config;
}

export function getOverridesByKey(
  key: OverrideConfigurationKey,
  overrides?: Readonly<RawOverrides>,
): RawOverrides {
  return (
    overrides
      ?.filter((o) => key in o.overrides)
      .map((o) => ({
        conditions: o.conditions,
        overrides: o.overrides[key] as RawFrigateCardConfig,
      })) ?? []
  );
}

// A tiny wrapper interface to allow the same manager to be passed around
// immutably within objects that will not be equal (===). Every state change
// generates a new epoch. This is used for Lit rendering to ensure changes to
// condition state are recognized as changes even though the manager is the
// same.
export interface ConditionsManagerEpoch {
  manager: Readonly<ConditionsManager>;
}

export type ConditionsManagerListener = () => void;

export class ConditionsManager {
  protected _api: CardConditionAPI;

  protected _state: ConditionState = {};
  protected _epoch: ConditionsManagerEpoch = this._createEpoch();
  protected _listeners: ConditionsManagerListener[];

  // Whether or not to include HA state in ConditionState. Doing so increases
  // CPU usage as HA state is pumped out very fast, so this is only enabled if
  // the configuration needs to consume it.
  protected _hasHAStateConditions = false;
  protected _mediaQueries: MediaQueryList[] = [];
  protected _mediaQueryTrigger = () => this._triggerChange();

  constructor(api: CardConditionAPI, listener?: ConditionsManagerListener) {
    this._api = api;
    this._listeners = [
      () => this._api.getConfigManager().computeOverrideConfig(),
      () => this._api.getAutomationsManager().execute(),
      ...(listener ? [listener] : []),
    ];
  }

  public removeConditions(): void {
    this._mediaQueries.forEach((mql) =>
      mql.removeEventListener('change', this._mediaQueryTrigger),
    );
    this._mediaQueries = [];
  }

  public setConditionsFromConfig(): void {
    this.removeConditions();

    const getAllConditions = (): FrigateCardCondition[] => {
      const config = this._api.getConfigManager().getConfig();
      const conditions: FrigateCardCondition[] = [];
      config?.overrides?.forEach((override) => conditions.push(override.conditions));

      // Element conditions can be arbitrarily nested underneath conditionals and
      // custom elements that this card may not known. Here we recursively parse
      // down the elements tree, parsing as we go to find valid conditions.
      const getElementsConditions = (data: unknown): void => {
        const parseResult = frigateConditionalSchema.safeParse(data);
        if (parseResult.success) {
          conditions.push(parseResult.data.conditions);
          parseResult.data.elements?.forEach(getElementsConditions);
        } else if (data && typeof data === 'object') {
          Object.keys(data).forEach((key) => getElementsConditions(data[key]));
        }
      };
      config?.elements?.forEach(getElementsConditions);
      return conditions;
    };

    const conditions = getAllConditions();
    this._hasHAStateConditions = conditions.some(
      (condition) => !!condition.state?.length,
    );
    conditions.forEach((condition) => {
      if (condition.media_query) {
        const mql = window.matchMedia(condition.media_query);
        mql.addEventListener('change', this._mediaQueryTrigger);
        this._mediaQueries.push(mql);
      }
    });
  }

  public setState(state: Partial<ConditionState>): void {
    this._state = {
      ...this._state,
      ...state,
    };
    this._triggerChange();
  }
  
  public getState(): ConditionState {
    return this._state;
  }

  public hasHAStateConditions(): boolean {
    return this._hasHAStateConditions;
  }

  public getEpoch(): ConditionsManagerEpoch {
    return this._epoch;
  }

  public evaluateCondition(
    condition: Readonly<FrigateCardCondition>,
    stateOverrides?: Partial<ConditionState>,
  ): boolean {
    const state = {
      ...this._state,
      ...stateOverrides,
    };

    let result = true;
    if (condition.view?.length) {
      result &&= !!state?.view && condition.view.includes(state.view);
    }
    if (condition.fullscreen !== undefined) {
      result &&=
        state.fullscreen !== undefined && condition.fullscreen === state.fullscreen;
    }
    if (condition.expand !== undefined) {
      result &&= state.expand !== undefined && condition.expand === state.expand;
    }
    if (condition.camera?.length) {
      result &&= !!state.camera && condition.camera.includes(state.camera);
    }
    if (condition.state?.length) {
      for (const stateTest of condition.state) {
        result &&=
          !!state.state &&
          ((!stateTest.state && !stateTest.state_not) ||
            (stateTest.entity in state.state &&
              (!stateTest.state ||
                state.state[stateTest.entity].state === stateTest.state) &&
              (!stateTest.state_not ||
                state.state[stateTest.entity].state !== stateTest.state_not)));
      }
    }
    if (condition.media_loaded !== undefined) {
      result &&=
        state.media_loaded !== undefined &&
        condition.media_loaded === state.media_loaded;
    }
    if (condition.media_query) {
      result &&= window.matchMedia(condition.media_query).matches;
    }
    if (condition.display_mode) {
      result &&= !!state.displayMode && condition.display_mode === state.displayMode;
    }
    if (condition.triggered?.length) {
      result &&= condition.triggered.some((triggeredCameraID) =>
        state.triggered?.has(triggeredCameraID),
      );
    }
    if (condition.interaction !== undefined) {
      result &&=
        state.interaction !== undefined && condition.interaction === state.interaction;
    }
    if (condition.microphone) {
      result &&=
        (condition.microphone.connected === undefined ||
          state.microphone?.connected === condition.microphone.connected) &&
        (condition.microphone.muted === undefined ||
          state.microphone?.muted === condition.microphone.muted);
    }
    return result;
  }

  protected _createEpoch(): ConditionsManagerEpoch {
    return { manager: this };
  }

  protected _triggerChange(): void {
    this._epoch = this._createEpoch();
    this._listeners.forEach((listener) => listener());
  }
}

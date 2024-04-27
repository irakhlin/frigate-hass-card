import Panzoom, { PanzoomEventDetail, PanzoomObject } from '@dermotduffy/panzoom';
import debounce from 'lodash-es/debounce';
import round from 'lodash-es/round';
import {
  arefloatsApproximatelyEqual,
  dispatchFrigateCardEvent,
  isHoverableDevice,
} from '../../utils/basic';
import { ZoomConfig } from './types';

const ZOOM_DEFAULT_PAN_X = 50;
const ZOOM_DEFAULT_PAN_Y = 50;
const ZOOM_DEFAULT_SCALE = 1;
const ZOOM_PRECISION = 4;

export class ZoomController {
  protected _element: HTMLElement;
  protected _panzoom?: PanzoomObject;

  // Is the controller zoomed in at all?
  protected _zoomed = false;

  // Is the controller set to the default zoom/pan settings?
  protected _default = true;

  // Should clicks be allowed to propagate, or consumed as a pan/zoom action?
  protected _allowClick = true;

  protected _defaultConfig: ZoomConfig | null;
  protected _config: ZoomConfig | null;

  // When the user pans/zooms changes may be created at a very high rate.
  protected _debouncedChangeHandler = debounce(this._changeHandler.bind(this), 200);

  // Multiple calls to setConfig() or setDefaultConfig() or resizes should only
  // update once.
  protected _debouncedUpdater = debounce(this._updateBasedOnConfig.bind(this), 200);

  protected _resizeObserver = new ResizeObserver(this._debouncedUpdater);

  protected _events = isHoverableDevice()
    ? {
        down: ['pointerdown'],
        move: ['pointermove'],
        up: ['pointerup', 'pointerleave', 'pointercancel'],
      }
    : {
        down: ['touchstart'],
        move: ['touchmove'],
        up: ['touchend', 'touchcancel'],
      };

  protected _downHandler = (ev: Event) => {
    if (this._shouldZoomOrPan(ev)) {
      this._panzoom?.handleDown(ev as PointerEvent);
      ev.stopPropagation();

      // If we do not prevent default here, the media carousels scroll.
      ev.preventDefault();
      this._allowClick = false;
    } else {
      this._allowClick = true;
    }
  };

  protected _clickHandler = (ev: Event) => {
    // When mouse clicking is used to pan, need to avoid that causing a click
    // handler elsewhere in the card being called. Example: Viewing a snapshot,
    // and panning within it should not cause a related clip to play (the click
    // handler in the viewer).
    if (!this._allowClick) {
      ev.stopPropagation();
    }
    this._allowClick = true;
  };

  protected _moveHandler = (ev: Event) => {
    if (this._shouldZoomOrPan(ev)) {
      this._panzoom?.handleMove(ev as PointerEvent);
      ev.stopPropagation();
    }
  };

  protected _upHandler = (ev: Event) => {
    if (this._shouldZoomOrPan(ev)) {
      this._panzoom?.handleUp(ev as PointerEvent);
      ev.stopPropagation();
    }
  };

  protected _wheelHandler = (ev: Event) => {
    if (ev instanceof WheelEvent && this._shouldZoomOrPan(ev)) {
      this._panzoom?.zoomWithWheel(ev);
      ev.stopPropagation();
    }
  };

  constructor(
    element: HTMLElement,
    options?: { config?: ZoomConfig | null; defaultConfig?: ZoomConfig | null },
  ) {
    this._element = element;
    this._config = options?.config ?? null;
    this._defaultConfig = options?.defaultConfig ?? null;
  }

  public activate(): void {
    const config = this._getConfigToUse();
    const converted = this._convertPercentToXYPan(
      config?.pan?.x ?? ZOOM_DEFAULT_PAN_X,
      config?.pan?.y ?? ZOOM_DEFAULT_PAN_Y,
      config?.zoom ?? ZOOM_DEFAULT_SCALE,
    );

    this._panzoom = Panzoom(this._element, {
      contain: 'outside',
      maxScale: 10,
      minScale: 1,
      noBind: true,
      // Do not force the cursor style (by default it will always show the
      // 'move' type cursor whether or not it is zoomed in).
      cursor: undefined,

      // Disable automatic touchAction setting from Panzoom() as otherwise it
      // effectively disables dashboard scrolling. See:
      // https://github.com/dermotduffy/frigate-hass-card/issues/1181
      touchAction: '',

      // Set the initial pan/zoom values to avoid an initial unzoomed view.
      ...(config && converted && { startX: converted.x }),
      ...(config && converted && { startY: converted.y }),
      ...(config &&
        converted && {
          startScale:
            config.zoom ??
            // This is not reachable as without a zoom value, a default of 1 is
            // assumed in _convertPercentToXYPan, which will return null @
            // default zoom, and so this cannot be reached in practice.
            /* istanbul ignore next @preserve */
            ZOOM_DEFAULT_SCALE,
        }),
    });

    const registerListeners = (
      events: string[],
      func: (ev: Event) => void,
      options?: AddEventListenerOptions,
    ) => {
      events.forEach((eventName) => {
        this._element.addEventListener(eventName, func, options);
      });
    };

    registerListeners(this._events['down'], this._downHandler, { capture: true });
    registerListeners(this._events['move'], this._moveHandler, { capture: true });
    registerListeners(this._events['up'], this._upHandler, { capture: true });
    registerListeners(['wheel'], this._wheelHandler);
    registerListeners(['click'], this._clickHandler, { capture: true });

    this._resizeObserver.observe(this._element);
    this._element.addEventListener('panzoomchange', this._debouncedChangeHandler);
  }

  public deactivate(): void {
    const unregisterListener = (
      events: string[],
      func: (ev: Event) => void,
      options?: EventListenerOptions,
    ) => {
      events.forEach((eventName) => {
        this._element.removeEventListener(eventName, func, options);
      });
    };

    unregisterListener(this._events['down'], this._downHandler, { capture: true });
    unregisterListener(this._events['move'], this._moveHandler, { capture: true });
    unregisterListener(this._events['up'], this._upHandler, { capture: true });
    unregisterListener(['wheel'], this._wheelHandler);
    unregisterListener(['click'], this._clickHandler, { capture: true });

    this._resizeObserver.disconnect();
    this._element.removeEventListener('panzoomchange', this._debouncedChangeHandler);
  }

  public setDefaultConfig(config: ZoomConfig | null): void {
    this._defaultConfig = config;
    this._debouncedUpdater();
  }

  public setConfig(config: ZoomConfig): void {
    this._config = config;
    this._debouncedUpdater();
  }

  protected _changeHandler(ev: Event): void {
    const pz = (<CustomEvent<PanzoomEventDetail>>ev).detail;

    const isUnzoomed = this._isUnzoomed(pz.scale);
    const isAtDefault = this._isAtDefaultZoomAndPan(pz.x, pz.y, pz.scale);

    // Take care here to only dispatch the zoomed/unzoomed events when the
    // absolute state changes (rather than on every single zoom adjustment).
    if (isUnzoomed && this._zoomed) {
      this._zoomed = false;
      this._setTouchAction(true);
      dispatchFrigateCardEvent(this._element, 'zoom:unzoomed');
    } else if (!isUnzoomed && !this._zoomed) {
      this._zoomed = true;
      this._setTouchAction(false);
      dispatchFrigateCardEvent(this._element, 'zoom:zoomed');
    }

    if (isAtDefault && !this._default) {
      this._default = true;
      dispatchFrigateCardEvent(this._element, 'zoom:default', { isDefault: true });
    } else if (!isAtDefault && this._default) {
      this._default = false;
      dispatchFrigateCardEvent(this._element, 'zoom:default', { isDefault: false });
    }
  }

  protected _isZoomEqual(a: ZoomConfig, b: ZoomConfig): boolean {
    // The ?? clauses below cannot be reached since this function is only ever
    // used fully specified by this object. It's kept as-is for completeness.
    return (
      arefloatsApproximatelyEqual(
        /* istanbul ignore next @preserve */
        a.zoom ?? ZOOM_DEFAULT_SCALE,
        /* istanbul ignore next @preserve */
        b.zoom ?? ZOOM_DEFAULT_SCALE,
        ZOOM_PRECISION,
      ) &&
      arefloatsApproximatelyEqual(
        /* istanbul ignore next @preserve */
        a.pan?.x ?? ZOOM_DEFAULT_PAN_X,
        /* istanbul ignore next @preserve */
        b.pan?.x ?? ZOOM_DEFAULT_PAN_X,
        ZOOM_PRECISION,
      ) &&
      arefloatsApproximatelyEqual(
        /* istanbul ignore next @preserve */
        a.pan?.y ?? ZOOM_DEFAULT_PAN_Y,
        /* istanbul ignore next @preserve */
        b.pan?.y ?? ZOOM_DEFAULT_PAN_Y,
        ZOOM_PRECISION,
      )
    );
  }

  protected _isZoomEmpty(config?: ZoomConfig | null): boolean {
    return (
      config?.pan?.x === undefined &&
      config?.pan?.y === undefined &&
      config?.zoom === undefined
    );
  }

  protected _getConfigToUse(): ZoomConfig | null {
    return this._isZoomEmpty(this._config) ? this._defaultConfig : this._config;
  }

  protected _updateBasedOnConfig(): void {
    if (!this._panzoom) {
      return;
    }

    const config = this._getConfigToUse();
    const desiredScale = config?.zoom ?? ZOOM_DEFAULT_SCALE;

    // Transform won't exist (will be null) if the element has no dimensions, or
    // if the desired scale has no zoom (i.e. is 1).
    const converted = this._convertPercentToXYPan(
      config?.pan?.x ?? ZOOM_DEFAULT_PAN_X,
      config?.pan?.y ?? ZOOM_DEFAULT_PAN_Y,
      desiredScale,
    );

    const x = converted?.x ?? 0;
    const y = converted?.y ?? 0;

    // Verify there is a material change in the pan/zoom settings before acting.
    if (
      this._isZoomEqual(
        { zoom: desiredScale, pan: { x: x, y: y } },
        {
          zoom: this._panzoom.getScale(),
          pan: this._panzoom.getPan(),
        },
      )
    ) {
      return;
    }

    this._panzoom.zoom(desiredScale, {
      animate: false,
    });

    // Panzoom must allow the browser to paint the zoomed image in order to
    // "contain" the pan within the parent, this creates somewhat of an async
    // situation where we need to ensure the zoom completes first. Using
    // `requestAnimationFrame` appears to reliably allow the zoom to finish
    // rendering first, before the pain is applied.
    // See: https://github.com/timmywil/panzoom?tab=readme-ov-file#a-note-on-the-async-nature-of-panzoom
    window.requestAnimationFrame(() => {
      this._panzoom?.pan(x, y, {
        animate: false,
      });
    });
  }

  /**
   * Convert from Frigate card pan % values to Panzoom X/Y transformation
   * coordinates.
   * @param x The x translation value.
   * @param y The y translation value.
   * @param scale The desired (not current) scale.
   * @returns An object with x/y pan % values or null on error.
   */
  protected _convertPercentToXYPan(
    x: number,
    y: number,
    scale: number,
  ): { x: number; y: number } | null {
    const minMax = this._getTransformMinMax(scale, this._panzoom?.getScale());
    if (minMax === null) {
      return null;
    }

    return {
      x: minMax.minX + (minMax.maxX - minMax.minX) * (x / 100),
      y: minMax.minY + (minMax.maxY - minMax.minY) * (y / 100),
    };
  }

  protected _getTransformMinMax(
    desiredScale: number,
    currentScale?: number,
  ): {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } | null {
    const rendered = this._getRenderedSize(currentScale);

    if (!rendered.width || !rendered.height) {
      return null;
    }

    const minX = (rendered.width * (desiredScale - 1)) / desiredScale / 2;
    const minY = (rendered.height * (desiredScale - 1)) / desiredScale / 2;

    if (arefloatsApproximatelyEqual(minX, 0) || arefloatsApproximatelyEqual(minY, 0)) {
      return null;
    }

    return {
      minX: minX,
      maxX: -minX,
      minY: minY,
      maxY: -minY,
    };
  }

  protected _getRenderedSize(scale?: number): { width: number; height: number } {
    const rect = this._element.getBoundingClientRect();
    return {
      width: rect.width / (scale ?? ZOOM_DEFAULT_SCALE),
      height: rect.height / (scale ?? ZOOM_DEFAULT_SCALE),
    };
  }

  protected _isUnzoomed(scale?: number): boolean {
    return scale !== undefined && round(scale, ZOOM_PRECISION) <= 1;
  }

  protected _isAtDefaultZoomAndPan(x: number, y: number, scale: number): boolean {
    if (!this._defaultConfig) {
      return this._isUnzoomed(scale);
    }

    const convertedDefault = this._convertPercentToXYPan(
      this._defaultConfig.pan?.x ?? ZOOM_DEFAULT_PAN_X,
      this._defaultConfig.pan?.y ?? ZOOM_DEFAULT_PAN_Y,
      this._defaultConfig.zoom ?? ZOOM_DEFAULT_SCALE,
    );
    if (!convertedDefault) {
      return true;
    }

    return (
      arefloatsApproximatelyEqual(x, convertedDefault.x) &&
      arefloatsApproximatelyEqual(y, convertedDefault.y) &&
      arefloatsApproximatelyEqual(
        scale,
        this._defaultConfig.zoom ??
          // The ZOOM_DEFAULT_SCALE clause below cannot be reached since when
          // this._defaultConfig.zoom is undefined, convertedDefault will end up
          // null above and this function will have already returned.
          /* istanbul ignore next @preserve */
          ZOOM_DEFAULT_SCALE,
      )
    );
  }

  protected _shouldZoomOrPan(ev: Event): boolean {
    return (
      !this._isUnzoomed(this._panzoom?.getScale()) ||
      // TouchEvent does not exist on Firefox on non-touch events. See:
      // https://github.com/dermotduffy/frigate-hass-card/issues/1174
      (window.TouchEvent && ev instanceof TouchEvent && ev.touches.length > 1) ||
      (ev instanceof WheelEvent && ev.ctrlKey)
    );
  }

  protected _setTouchAction(touchEnabled: boolean): void {
    this._element.style.touchAction = touchEnabled ? '' : 'none';
  }
}

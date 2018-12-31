import { PluginObject, PluginFunction } from '../types/plugin'

import EventEmitter from './scroll/event-emitter'
import BScrollOptions from './scroll/options'
import BScrollProcessor from './scroll/processor'

import { warn } from './util/debug'
import { isUndef } from './util/lang'

import {
  hasTouch,
  style,
  offset,
  getRect,
  preventDefaultException
} from './util/dom'
import Processor from './scroll/processor';

// Type Guards
export function isPluginObject(
  plugin: PluginObject | PluginFunction
): plugin is PluginObject {
  return typeof (plugin as PluginObject).install === 'function'
}

interface plugin {
  [key: string]: {
    new (bscroll: BScroll): void
  }
}
export default class BScroll extends EventEmitter {
  static readonly Version: string = '2.0.0'
  static _installedPlugins?: (Object | Function)[]
  static _plugins : plugin

  wrapper: HTMLElement | null
  scroller: HTMLElement
  scrollerStyle?: object
  x: number
  y: number
  directionX?: number
  directionY?: number
  options: BScrollOptions
  translateZ?: string
  lastScale: number
  scale: number
  enabled: boolean
  [key: string]: any

  static use(plugin: PluginObject | PluginFunction, ...options: any[]) {
    const installedPlugins = this._installedPlugins || (this._installedPlugins = [])
    if (installedPlugins.indexOf(plugin) > -1) {
      return this
    }

    options.unshift(this)
    if (isPluginObject(plugin)) {
      plugin.install.apply(plugin, options as any)
    } else if (typeof plugin === 'function') {
      plugin.apply(null, options as any)
    }
    installedPlugins.push(plugin)
    return this
  }

  static plugin(name: string, ctor: {
    new (): void
  }): void {
    if (!this._plugins) {
      this._plugins = {}
    }
    if (this._plugins[name]) {
      warn(
        `This plugin has been registered, maybe you need change plugin's name`
      )
    }
    this._plugins[name] = ctor
  }

  constructor(el: HTMLElement | string, options: object) {
    super()
    this.wrapper = typeof el === 'string' ? document.querySelector(el) : el

    if (!this.wrapper) {
      warn('Can not resolve the wrapper DOM.')
      return
    }
    this.scroller = this.wrapper.children[0] as HTMLElement
    if (!this.scroller) {
      warn('The wrapper need at least one child element to be scroller.')
      return
    }
    // cache style for better performance
    this.scrollerStyle = this.scroller.style
    this.options = new BScrollOptions().merge(options).process()
    this.init()
  }

  private init() {
    const {
      observeDOM,
      autoBlur,
      snap,
      startX,
      startY
    } = this.options

    this.x = 0
    this.y = 0
    this.directionX = 0
    this.directionY = 0

    this.setScale(1)

    this.processor = new BScrollProcessor(this)

    this.applyPlugins()

    this.watchTransition()

    if (observeDOM) {
      this.initDOMObserver()
    }

    if (autoBlur) {
      this.handleAutoBlur()
    }

    this.refresh()

    if (!snap) {
      this.scrollTo(startX, startY)
    }

    this.enable()
  }
  setScale(scale: number) {
    this.lastScale = isUndef(this.scale) ? scale : this.scale
    this.scale = scale
  }
  private applyPlugins() {
    const options = this.options
    const _plugins = (<typeof BScroll>this.constructor)._plugins || {}
    let ctor
    for (let pluginName in _plugins) {
      ctor = _plugins[pluginName]
      if (options[pluginName]) {
        typeof ctor === 'function' && new ctor(this)
      }
    }
  }
  private initDOMObserver() {
    if (typeof MutationObserver !== 'undefined') {
      let timer: number
      let observer = new MutationObserver(mutations => {
        // don't do any refresh during the transition, or outside of the boundaries
        if (this.shouldNotRefresh()) {
          return
        }
        let immediateRefresh = false
        let deferredRefresh = false
        for (let i = 0; i < mutations.length; i++) {
          const mutation = mutations[i]
          if (mutation.type !== 'attributes') {
            immediateRefresh = true
            break
          } else {
            if (mutation.target !== this.scroller) {
              deferredRefresh = true
              break
            }
          }
        }
        if (immediateRefresh) {
          this.refresh()
        } else if (deferredRefresh) {
          // attributes changes too often
          clearTimeout(timer)
          timer = setTimeout(() => {
            if (!this.shouldNotRefresh()) {
              this.refresh()
            }
          }, 60)
        }
      })
      const config = {
        attributes: true,
        childList: true,
        subtree: true
      }
      observer.observe(this.scroller, config)

      // TODO
      this.on('destroy', () => {
        observer.disconnect()
      })
    } else {
      this.checkDOMUpdate()
    }
  }
  private shouldNotRefresh() {
    let outsideBoundaries =
      this.x > this.minScrollX ||
      this.x < this.maxScrollX ||
      this.y > this.minScrollY ||
      this.y < this.maxScrollY
    return this.isInTransition || this.stopFromTransition || outsideBoundaries
  }
  private checkDOMUpdate() {
    let scrollerRect = getRect(this.scroller)
    let oldWidth = scrollerRect.width
    let oldHeight = scrollerRect.height

    function check(this: BScroll) {
      if (this.destroyed) {
        return
      }
      scrollerRect = getRect(this.scroller)
      let newWidth = scrollerRect.width
      let newHeight = scrollerRect.height

      if (oldWidth !== newWidth || oldHeight !== newHeight) {
        this.refresh()
      }
      oldWidth = newWidth
      oldHeight = newHeight

      next.call(this)
    }

    function next(this: BScroll) {
      setTimeout(() => {
        check.call(this)
      }, 1000)
    }

    next.call(this)
  }
  private watchTransition() {
    if (typeof Object.defineProperty !== 'function') {
      return
    }
    let me = this
    let isInTransition = false
    let key = this.useTransition ? 'isInTransition' : 'isAnimating'
    Object.defineProperty(this, key, {
      get() {
        return isInTransition
      },
      set(newVal) {
        isInTransition = newVal
        // fix issue #359
        let el = me.scroller.children.length
          ? me.scroller.children
          : [me.scroller]
        let pointerEvents = isInTransition && !me.pulling ? 'none' : 'auto'
        for (let i = 0; i < el.length; i++) {
          (el[i] as HTMLElement).style.pointerEvents = pointerEvents
        }
      }
    })
  }
  private handleAutoBlur() {
    this.on('scrollStart', () => {
      let activeElement = document.activeElement as HTMLElement
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' ||
          activeElement.tagName === 'TEXTAREA')
      ) {
        activeElement.blur()
      }
    })
  }
  handleEvent(e: Event) {
    switch (e.type) {
      case 'touchstart':
      case 'mousedown':
        this._start(e)
        if (this.options.zoom && e.touches && e.touches.length > 1) {
          this._zoomStart(e)
        }
        break
      case 'touchmove':
      case 'mousemove':
        if (this.options.zoom && e.touches && e.touches.length > 1) {
          this._zoom(e)
        } else {
          this._move(e)
        }
        break
      case 'touchend':
      case 'mouseup':
      case 'touchcancel':
      case 'mousecancel':
        if (this.scaled) {
          this._zoomEnd(e)
        } else {
          this._end(e)
        }
        break
      case 'orientationchange':
      case 'resize':
        this._resize()
        break
      case 'transitionend':
      case 'webkitTransitionEnd':
      case 'oTransitionEnd':
      case 'MSTransitionEnd':
        this._transitionEnd(e)
        break
      case 'click':
        if (this.enabled && !e._constructed) {
          if (
            !preventDefaultException(
              e.target,
              this.options.preventDefaultException
            )
          ) {
            e.preventDefault()
            e.stopPropagation()
          }
        }
        break
      case 'wheel':
      case 'DOMMouseScroll':
      case 'mousewheel':
        this._onMouseWheel(e)
        break
    }
  }
  refresh() {
    const wrapper = this.wrapper as HTMLElement
    const isWrapperStatic =
      window.getComputedStyle(wrapper, null).position === 'static'
    let wrapperRect = getRect(wrapper)
    this.wrapperWidth = wrapperRect.width
    this.wrapperHeight = wrapperRect.height

    let scrollerRect = getRect(this.scroller)
    this.scrollerWidth = Math.round(scrollerRect.width * this.scale)
    this.scrollerHeight = Math.round(scrollerRect.height * this.scale)

    this.relativeX = scrollerRect.left
    this.relativeY = scrollerRect.top

    if (isWrapperStatic) {
      this.relativeX -= wrapperRect.left
      this.relativeY -= wrapperRect.top
    }

    this.minScrollX = 0
    this.minScrollY = 0

    this.hasHorizontalScroll =
      this.options.scrollX && this.maxScrollX < this.minScrollX
    this.hasVerticalScroll =
      this.options.scrollY && this.maxScrollY < this.minScrollY

    if (!this.hasHorizontalScroll) {
      this.maxScrollX = this.minScrollX
      this.scrollerWidth = this.wrapperWidth
    }

    if (!this.hasVerticalScroll) {
      this.maxScrollY = this.minScrollY
      this.scrollerHeight = this.wrapperHeight
    }

    this.endTime = 0
    this.directionX = 0
    this.directionY = 0
    this.wrapperOffset = offset(this.wrapper)

    this.trigger('refresh')

    !this.scaled && this.resetPosition()
  }
  enable() {
    this.enabled = true
  }
  disable() {
    this.enabled = false
  }
}

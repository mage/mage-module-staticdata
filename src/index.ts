import 'reflect-metadata'

import { Type, plainToClass } from 'class-transformer'
import * as validator from 'class-validator'
import * as fs from 'fs'
import * as mage from 'mage'
import * as zlib from 'zlib'

const msgServer = mage.core.msgServer
const STATIC_DATA_UPDATE_EVENT = 'staticData.update'

/**
 * We internally track three data types:
 *
 *   1. Scalar, which are dropped in place just like any other data
 *   2. Array, for which we will instanciate one instance of each
 *   3. Object, for which we instanciate an instance
 *
 * These types are used to parse and stringify all attributes
 * and nested attributes of the static data object.
 *
 * @export
 * @enum {number}
 */
export const enum ValueType {
  Scalar,
  Array,
  Object
}

/**
 * Target class instance.
 *
 * @export
 * @interface ITarget
 */
export interface ITarget {
  [key: string]: any
}

/**
 * Metadata we will stack on our target classes
 *
 * @export
 * @interface IMetaData
 */
export interface IMetaData {
  remoteName: string
  opts: any
  type: ValueType
}

/**
 * Key-value map
 *
 * @export
 * @interface IMetaDataMap
 */
export interface IMetaDataMap {
  [key: string]: IMetaData
}


/**
 * Validation error classes
 *
 * Will contain all the validation errors that were found upon validation.
 *
 * @export
 * @class ValidationError
 * @extends {Error}
 */
export class ValidationError extends Error {
  public details: any[]
  public key: string

  constructor(message: string, details: any) {
    super(message)
    this.key = message
    this.details = details
    this.name = 'ValidationError'
  }
}

/**
 * Make the validate method from class-validator throw
 *
 * @param {*} val
 * @returns
 */
async function validate(message: string, val: any) {
  const errors = await validator.validate(val)

  if (errors.length !== 0) {
    throw new ValidationError(message, errors)
  }
}

/**
 * We specifically mention the type of the hidden
 * static metadata container
 *
 * @export
 * @interface StaticDataClass
 * @extends {ITarget}
 */
export class StaticDataClass implements ITarget {
  public static _staticDataMeta: IMetaDataMap
}

/**
 * Compute the metadata which we will attach
 * to a static data class
 *
 * @param {*} target
 * @param {string} key
 * @param {string} remoteName
 * @param {*} [childClass]
 * @returns
 */
function computeMetadata(target: any, key: string, remoteName: string, opts?: any) {
  const Info = Reflect.getMetadata('design:type', target, key)
  const instance = new Info()
  let type = ValueType.Object

  if (instance instanceof String || instance instanceof Number || instance instanceof Boolean) {
    type = ValueType.Scalar
  } else if (Array.isArray(instance)) {
    type = ValueType.Array
  }

  // Apply the Type decorator automatically
  if (type !== ValueType.Scalar) {
    Type(() => opts)(target, key)
  }

  return {
    remoteName,
    opts,
    type
  }
}

/**
 * Return the metadata tree for this static data class
 *
 * @param target
 */
function extractMetaData(target: typeof StaticDataClass) {
  const meta = target._staticDataMeta
  const keys = Object.keys(meta)
  const ret: any = {}

  for (const key of keys) {
    const {
      opts,
      remoteName: name,
      type
    } = meta[key]

    ret[key] = {
      name,
      type,
      meta: opts && opts._staticDataMeta ? extractMetaData(opts) : opts
    }
  }

  return ret
}

/**
 * The walk function processes anonymous data
 * against the schema defined by the class metadata
 *
 * @param {*} data
 * @param {StaticDataClass} Target
 * @returns
 */
async function walk(parent: string, data: any, Target: typeof StaticDataClass) {
  // Return the received data if we are dealing with a literal
  if (!Target) {
    return data
  }

  const instance = new (<any> Target)()
  const meta = Target._staticDataMeta
  const keys = Object.keys(meta)

  for (const key of keys) {
    const keyMeta = meta[key]
    const val = data[key]

    instance[key] = await parseAttribute(`${parent}.${key}`, val, keyMeta)
  }

  return instance
}

/**
 * Parse a single attribute based on received metadata
 *
 * @param {*} val
 * @param {any} keyMeta
 * @returns
 */
async function parseAttribute(key: string, val: any, keyMeta: IMetaData) {
   switch (keyMeta.type) {
    case ValueType.Scalar:
      return val

    case ValueType.Array:
      const arrayInstance: any[] = []
      if (!val) {
        return arrayInstance
      }

      for (const [index, arrayVal] of val.entries()) {
        const childKey = `${key}[${index}]`
        const childInstance = await walk(childKey, arrayVal, keyMeta.opts)

        await validate(childKey, childInstance)

        arrayInstance.push(childInstance)
      }
      return arrayInstance

    case ValueType.Object:
      const instance = await walk(key, val, keyMeta.opts)
      await validate(key, instance)
      return instance
  }
}

/**
 * Static Data marker attribute
 *
 * This decorator helps us figure out:
 *
 *   1. What name will we use externally to refer to this attribute
 *      (e.g. what name we'll be using in our Excel files, etc)
 *   2. What the subtype of the data will be
 *
 * @export
 * @param {string} remoteName
 * @param {*} [childClass]
 * @returns
 */
export function StaticData(remoteName: string, childClass?: any) {
  return function (target: StaticDataClass, key: string) {
    const type: any = target.constructor
    const meta = computeMetadata(target, key, remoteName, childClass)

    if (!type._staticDataMeta) {
      type._staticDataMeta = {}
    }

    type._staticDataMeta[key] = meta
  }
}

/**
 * The abstractStaticDataModule class is to be used to
 * define a StaticDataModule class which will then immediately be
 * instanciated as a module.
 *
 * @export
 * @abstract
 * @class AbstractStaticDataModule
 */
export abstract class AbstractStaticDataModule {
  public abstract StaticDataClass: typeof StaticDataClass
  public abstract staticData: StaticDataClass

  public logger: mage.core.ILogger
  private dumpLocation: string

  constructor() {
    this.logger = mage.logger.context('StaticDataModule')
    this.dumpLocation = mage.core.config.get('static.location') || 'static.dat'
  }

  /**
   * Inheriting class tells us how to access
   * the data (from database, from S3, etc)
   *
   * If an empty string is returned, we will try to
   * load a local dump during development; if no local
   * dumps are available, we will simply not load any data
   * in memory (this is useful for initially creating the
   * schema, then exporting it to a Google Spreadsheet)
   *
   * @abstract
   * @returns {Promise<string>} Stringified static data
   *
   * @memberof AbstractStaticDataModule
   */
  public async load(): Promise<string> {
    return this.loadDump()
  }

  /**
   * We send stringified data back to the inheriting class;
   * it is then responsible to store it back where it will read
   * it from upon startup or reload
   *
   * @abstract
   * @param {string} data
   * @returns {Promise<void>}
   *
   * @memberof AbstractStaticDataModule
   */
  public async store(data: string): Promise<void> {
    await this.dump(data)
    return this.notify(data)
  }

  /**
   * Notify all server nodes of a received update.
   *
   * By default, we will send the static data to
   * all other servers; while this is pratical for
   * initial use,
   *
   * @param {string} data
   *
   * @memberof AbstractStaticDataModule
   */
  // tslint:disable-next-line:prefer-function-over-method
  public async notify(data?: string) {
    const content = []

    if (data) {
      content.push(data)
    }

    const Envelope = msgServer.mmrp.Envelope
    const staticDataUpdate = new Envelope(STATIC_DATA_UPDATE_EVENT, content)

    msgServer.getMmrpNode().broadcast(staticDataUpdate)
  }

  /**
   * Processing an update received from another node.
   *
   * By default, we receive the data directly from the other node,
   * load it locally, and then store it. While this is nice to start
   * with, you will most likely want to develop your own
   * synchronisation method (either load from database or
   * from another external source)
   *
   * @memberof AbstractStaticDataModule
   */
  public async update(json?: string) {
    if (!json) {
      throw new Error('Received no data upon update')
    }

    const data = JSON.parse(json)
    this.staticData = await this.parse(data)

    await this.dump(data)
  }

  /**
   * MAGE module setup method
   *
   * @param {mage.core.IState} state
   * @param {(error?: Error) => void} callback
   *
   * @memberof AbstractStaticDataModule
   */
  public async setup(_state: mage.core.IState, callback: (error?: Error) => void) {
    let data: any

    // Cluster communication
    msgServer.getMmrpNode().on(`delivery.${STATIC_DATA_UPDATE_EVENT}`, async ({ messages }) => {
      let message

      if (messages.length === 1) {
        message = messages[0].toString()
      }

      await this.update(message)
    })

    try {
      const json = await this.load()
      data = JSON.parse(json)
      this.staticData = await this.parse(data)
    } catch (error) {
      this.logger.error('Failed to load static data:', error)
      this.staticData = new this.StaticDataClass()
    }

    callback()
  }

  /**
   * Import data from a remote source (normally a Google Spreadsheet using
   * the MAGE Static Data Manager)
   *
   * @param {mage.core.IState} state
   * @param {*} data
   * @returns {Promise<void>}
   *
   * @memberof AbstractStaticDataModule
   */
  public async import(_state: mage.core.IState, data: any): Promise<ValidationError| void> {
    this.staticData = await this.parse(data)

    await this.store(this.stringify(data))
  }

  /**
   * Validate data from a remote source (normally a Google Spreadsheet using
   * the MAGE Static Data Manager)
   *
   * @param {mage.core.IState} state
   * @param {*} data
   * @returns {Promise<void>}
   *
   * @memberof AbstractStaticDataModule
   */
  public async validate(_state: mage.core.IState, data: any): Promise<ValidationError | void> {
    try {
      await this.parse(data)
    } catch (errors) {
      return errors
    }
  }

  /**
   * Export data to a remote destination (normally a Google Spreadsheet using
   * the MAGE Static Data Manager)
   *
   * @param {mage.core.IState} state
   * @returns {Promise<void>}
   *
   * @memberof AbstractStaticDataModule
   */
  public async export(_state: mage.core.IState): Promise<any> {
    return {
      data: this.staticData,
      schema: extractMetaData(this.StaticDataClass)
    }
  }

  /**
   * Store data to a local dump file
   *
   * @param {string} data
   * @returns {Promise<void>}
   *
   * @memberof AbstractStaticDataModule
   */
  public async dump(data: string = this.stringify()): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      zlib.deflate(data, (compressError, compressedData) => {
        if (compressError) {
          return reject(compressError)
        }

        fs.writeFile(this.dumpLocation, compressedData, (fileError) => {
          if (fileError) {
            return reject(fileError)
          }

          return resolve()
        })
      })
    })
  }

  /**
   * Load data from a local dump file
   *
   * @returns {Promise<string>}
   *
   * @memberof AbstractStaticDataModule
   */
  public async loadDump(): Promise<string> {
     return new Promise<string>((resolve, reject) => {
      fs.readFile(this.dumpLocation, (fileError, compressedData) => {
        if (fileError) {
          return reject(fileError)
        }

        zlib.inflate(compressedData, (decompressError, data) => {
          if (decompressError) {
            return reject(decompressError)
          }

          return resolve(data.toString())
        })
      })
    })
  }

  /**
   * Parse received data against the StaticDataClass
   *
   * @param {string} json
   * @returns
   *
   * @memberof AbstractStaticDataModule
   */
  public async parse(data: any) {
    const { StaticDataClass } = this

    // plainToClass expects an array; so we create on, then consume
    // the first instance of the returned array
    const staticData = plainToClass(StaticDataClass, [data])[0]

    return walk('StaticData', staticData, StaticDataClass)
  }

  /**
   * Stringify the static data currently in memory
   *
   * @private
   * @returns
   *
   * @memberof AbstractStaticDataModule
   */
  public stringify(data?: any): string {
    return JSON.stringify(data || this.staticData)
  }
}

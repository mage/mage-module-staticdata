mage-module-staticdata
======================

Static data module (TypeScript), including a Google Spreadsheet add-on 
to manage exports and imports.

Installation
-------------

```shell
npm install --save mage-module-staticdata
```

If you wish to validate your schema upon import, you will
also want to install `class-validator`

```shell
npm install --save class-validator
```

Finally, if you plan to use the 
[MAGE Static Data Manager Add-on for Google Spreadsheets](https://chrome.google.com/webstore/detail/mage-static-data-manager/mkboklnalhmingcobmekbelgafiipioh),
you will also want to install `mage-https-devel`. This is needed
to allow seamless communication over HTTPS between the Google Spreadsheet
Add-on and your MAGE local server during development.

```shell
npm install --save mage-https-devel
```

Usage
-----

### Creating a module instance

> lib/modules/staticData/index.ts

```typescript
// Load the staticdata external module
import { AbstractStaticDataModule } from 'mage-module-staticdata'
import StaticData from './types/StaticData'

/**
 * Static Data module class
 *
 * We create an instance of this module, which will
 * be used to import, export, and provide static data.
 *
 * @class StaticDataModule
 * @extends {AbstractStaticDataModule}
 */
class StaticDataModule extends AbstractStaticDataModule {
  public StaticDataClass = StaticData
  public staticData: StaticData
}

export default new StaticDataModule()
```

### Creating user commands

For instance if you wish to use this module with the 
[MAGE Static Data Manager Add-on for Google Spreadsheets](https://chrome.google.com/webstore/detail/mage-static-data-manager/mkboklnalhmingcobmekbelgafiipioh),
you will need to create at least an `import` and `export` user command.

> lib/modules/staticData/usercommands/export.ts

```typescript
/**
 *
 * @module staticData
 */

// mage
import * as mage from 'mage'
import StaticDataModule from '../'

// validation tools
import { Acl } from 'mage-validator'

// User command
export default class {
  @Acl('*')
  public static async execute(state: mage.core.IState) {
    return StaticDataModule.export(state)
  }
}

```

### Creating your static data structure

> lib/modules/staticData/types/StaticData.ts

```typescript
import Card from './Card'

import { StaticData, StaticDataClass } from 'mage-module-staticdata'

/**
 * The StaticData class is the root]
 * class for static data; all static data
 * items must be added here.
 *
 * @export
 * @class
 * @extends {StaticDataClass}
 */
export default class extends StaticDataClass {
  @StaticData('カード', Card)
  public Cards: Card[]
}
```

The `@StaticData()` decorator takes the following parameters:

  1. **name**: Human-readable name; can be used by content management tools for display
  2. **options**: 
     - If the attribute is an array or an object, you will need to put the class for this attribute
     - Otherwise, it can be used to transmit metadata information usable by content management tools

> lib/modules/staticData/types/StaticData.ts

```typescript
import {
  IsAlpha,
  IsHalfWidth,
  IsNumber
} from 'class-validator'

import { StaticData, StaticDataClass } from 'mage-module-staticdata'

/**
 * Sample card class
 *
 * @export
 * @class
 * @extends {StaticDataClass}
 */
export default class extends StaticDataClass {
  @IsNumber()
  @StaticData('Item ID')
  public id: number

  @IsHalfWidth()
  @StaticData('名前')
  public name: string

  @IsAlpha()
  @StaticData('タイプ', {
    enum: ['a', 'b', 'c']
  })
  public type: string
}
```

Here we see that we can both add meta-data to our entry
and validation decorators.

### MAGE Static Data Manager Add-on for Google Spreadsheets

Coming soon (with link updates).

Storage & access to the static data
------------------------------------

### Location 

By default, your static data will be stored into a `static.dat` file
at the top level of your project. This behaviours is of course
configurable:

> config/default.yaml

```yaml
static:
  location: 'lib/modules/staticData/dump.dat'
```

### Remote storage

Additionally, you can alter your module class
by creating your own `load` and `store` methods;
this will allow you to distribute the update process
when pushing static data to a full-blown MAGE cluster.

> lib/modules/staticData/index.ts

```typescript
class StaticDataModule extends AbstractStaticDataModule {
  public StaticDataClass = StaticData
  public staticData: StaticData

  public async load(state: mage.core.IState): Promise<string> {
    // Load from database
  }

  public async store(state: mage.core.IState, data: string): Promise<void> {
    // Store to database
  }
}
```

This static data module instance will automatically make sure to broadcast
the static data update to all MAGE nodes in the cluster.

### Clustering

Unless you define a `load` and a `store` method override, data will automatically
be propagated throughout your cluster. If you wish to keep this behavior, simply
make sure to add the `notify` method call in your `store` override:

> lib/modules/staticData/index.ts

```typescript
class StaticDataModule extends AbstractStaticDataModule {
  public StaticDataClass = StaticData
  public staticData: StaticData

  public async load(state: mage.core.IState): Promise<string> {
    // Load from database
  }

  public async store(state: mage.core.IState, data: string): Promise<void> {
    // Store to database, then
    this.notify(data)
  }
}
```

However, doing this will likely pose scalability issues, since now you
will be sending static data from a single MAGE node to all other nodes. 
What you will likely want to do, instead, is add an `update` method override
which will take care of loading the data from the right location.

> lib/modules/staticData/index.ts

```typescript
class StaticDataModule extends AbstractStaticDataModule {
  public StaticDataClass = StaticData
  public staticData: StaticData

  public async load(state: mage.core.IState): Promise<string> {
    // Load from database
  }

  public async store(state: mage.core.IState, data: string): Promise<void> {
    // Store to database, then
    this.notify()
  }

  public async update() {
    // here, you can do one of two things: either restart the process
    // instance by quitting the current one
    mage.quit()
    
    // Or hot-load the data from your static data source
    const json = await this.load()
    const data = JSON.parse(json)
    this.staticData = await this.parse(data)
  }
}
```

License
-------

MIT.

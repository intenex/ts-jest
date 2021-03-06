/**
 * This is the core of settings and so ts-jest.
 * Since configuration are used to create a good cache key, everything
 * depending on it is here. Fast jest relies on correct cache keys
 * depending on all settings that could affect the generated output.
 *
 * The big issue is that jest calls first `getCacheKey()` with stringified
 * version of the `jest.ProjectConfig`, and then later it calls `process()`
 * with the complete, object version of it.
 */
import type { Config } from '@jest/types'
import { LogContexts, Logger } from 'bs-logger'
import { existsSync, readFileSync } from 'fs'
import { globsToMatcher } from 'jest-util'
import json5 = require('json5')
import { dirname, extname, isAbsolute, join, normalize, resolve } from 'path'
import {
  Bundle,
  CompilerOptions,
  CustomTransformers,
  Diagnostic,
  DiagnosticCategory,
  FormatDiagnosticsHost,
  ParsedCommandLine,
  ScriptTarget,
  SourceFile,
  TransformerFactory,
} from 'typescript'

import { digest as MY_DIGEST, version as MY_VERSION } from '..'
import { createCompilerInstance } from '../compiler/instance'
import { DEFAULT_JEST_TEST_MATCH } from '../constants'
import { internals as internalAstTransformers } from '../transformers'
import type {
  AstTransformerDesc,
  BabelConfig,
  BabelJestTransformer,
  ConfigCustomTransformer,
  TsCompiler,
  TsJestConfig,
  TsJestGlobalOptions,
  TsJestHooksMap,
  TTypeScript,
} from '../types'
import { backportJestConfig } from '../utils/backports'
import { getPackageVersion } from '../utils/get-package-version'
import { importer } from '../utils/importer'
import { stringify } from '../utils/json'
import { JsonableValue } from '../utils/jsonable-value'
import { rootLogger } from '../utils/logger'
import { Memoize } from '../utils/memoize'
import { Deprecations, Errors, ImportReasons, interpolate } from '../utils/messages'
import { normalizeSlashes } from '../utils/normalize-slashes'
import { sha1 } from '../utils/sha1'
import { TSError } from '../utils/ts-error'

const logger = rootLogger.child({ namespace: 'config' })

interface AstTransformerObj<T = Record<string, unknown>> {
  transformModule: AstTransformerDesc
  options?: T
}

interface AstTransformer {
  before: AstTransformerObj[]
  after?: AstTransformerObj[]
  afterDeclarations?: AstTransformerObj[]
}
/**
 * @internal
 */
export const IGNORE_DIAGNOSTIC_CODES = [
  6059, // "'rootDir' is expected to contain all source files."
  18002, // "The 'files' list in config file is empty."
  18003, // "No inputs were found in config file."
]
/**
 * @internal
 */
export const TS_JEST_OUT_DIR = '$$ts-jest$$'

const TARGET_TO_VERSION_MAPPING: Record<number, string> = {
  [ScriptTarget.ES2018]: 'es2018',
  [ScriptTarget.ES2019]: 'es2019',
  [ScriptTarget.ES2020]: 'es2020',
  [ScriptTarget.ESNext]: 'ESNext',
}

/**
 * @internal
 */
// WARNING: DO NOT CHANGE THE ORDER OF CODE NAMES!
// ONLY APPEND IF YOU NEED TO ADD SOME
const enum DiagnosticCodes {
  TsJest = 151000,
  ConfigModuleOption,
}

const normalizeRegex = (pattern: string | RegExp | undefined): string | undefined =>
  pattern ? (typeof pattern === 'string' ? pattern : pattern.source) : undefined

const toDiagnosticCode = (code: any): number | undefined =>
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
  code ? parseInt(`${code}`.trim().replace(/^TS/, ''), 10) ?? undefined : undefined

const toDiagnosticCodeList = (items: (string | number)[], into: number[] = []): number[] => {
  for (let item of items) {
    if (typeof item === 'string') {
      const children = item.trim().split(/\s*,\s*/g)
      if (children.length > 1) {
        toDiagnosticCodeList(children, into)
        continue
      }
      item = children[0]
    }
    if (!item) continue
    const code = toDiagnosticCode(item)
    if (code && !into.includes(code)) into.push(code)
  }

  return into
}

export class ConfigSet {
  /**
   * @internal
   */
  @Memoize()
  private get jest(): Config.ProjectConfig {
    const config = backportJestConfig(this.logger, this._jestConfig)

    this.logger.debug({ jestConfig: config }, 'normalized jest config')

    return config
  }

  /**
   * @internal
   */
  @Memoize()
  get isTestFile(): (fileName: string) => boolean {
    const matchablePatterns = [...this.jest.testMatch, ...this.jest.testRegex].filter(
      (pattern) =>
        /**
         * jest config testRegex doesn't always deliver the correct RegExp object
         * See https://github.com/facebook/jest/issues/9778
         */
        pattern instanceof RegExp || typeof pattern === 'string',
    )
    if (!matchablePatterns.length) {
      matchablePatterns.push(...DEFAULT_JEST_TEST_MATCH)
    }
    const stringPatterns = matchablePatterns.filter((pattern: any) => typeof pattern === 'string') as string[]
    const isMatch = globsToMatcher(stringPatterns)

    return (fileName: string) =>
      matchablePatterns.some((pattern) => (typeof pattern === 'string' ? isMatch(fileName) : pattern.test(fileName)))
  }

  /**
   * @internal
   */
  @Memoize()
  get tsJest(): TsJestConfig {
    const parsedConfig = this.jest
    const { globals = {} } = parsedConfig as any
    const options: TsJestGlobalOptions = { ...globals['ts-jest'] }

    // tsconfig
    if (options.tsConfig) {
      this.logger.warn(Deprecations.TsConfig)
    }
    const tsConfig: TsJestConfig['tsConfig'] = this.getInlineOrFileConfigOpt(
      options.tsConfig ?? options.tsconfig ?? true,
    )

    // packageJson
    const packageJson: TsJestConfig['packageJson'] = this.getInlineOrFileConfigOpt(options.packageJson ?? true)

    // transformers
    let transformers: ConfigCustomTransformer = Object.create(null)
    const { astTransformers } = options
    if (astTransformers) {
      if (Array.isArray(astTransformers)) {
        this.logger.warn(Deprecations.AstTransformerArrayConfig)

        transformers = {
          before: astTransformers.map((transformerPath) => ({
            path: this.resolvePath(transformerPath, { nodeResolve: true }),
          })),
        }
      } else {
        if (astTransformers.before) {
          transformers = {
            before: astTransformers.before.map((transformer) =>
              typeof transformer === 'string'
                ? {
                    path: this.resolvePath(transformer, { nodeResolve: true }),
                  }
                : {
                    ...transformer,
                    path: this.resolvePath(transformer.path, { nodeResolve: true }),
                  },
            ),
          }
        }
        if (astTransformers.after) {
          transformers = {
            ...transformers,
            after: astTransformers.after.map((transformer) =>
              typeof transformer === 'string'
                ? {
                    path: this.resolvePath(transformer, { nodeResolve: true }),
                  }
                : {
                    ...transformer,
                    path: this.resolvePath(transformer.path, { nodeResolve: true }),
                  },
            ),
          }
        }
        if (astTransformers.afterDeclarations) {
          transformers = {
            ...transformers,
            afterDeclarations: astTransformers.afterDeclarations.map((transformer) =>
              typeof transformer === 'string'
                ? {
                    path: this.resolvePath(transformer, { nodeResolve: true }),
                  }
                : {
                    ...transformer,
                    path: this.resolvePath(transformer.path, { nodeResolve: true }),
                  },
            ),
          }
        }
      }
    }

    // babel config (for babel-jest) default is undefined so we don't need to have fallback like tsConfig or packageJson
    const babelConfig: TsJestConfig['babelConfig'] = this.getInlineOrFileConfigOpt(options.babelConfig)

    // diagnostics
    let diagnostics: TsJestConfig['diagnostics']
    const diagnosticsOpt = options.diagnostics ?? true
    const ignoreList: (string | number)[] = [...IGNORE_DIAGNOSTIC_CODES]
    if (typeof diagnosticsOpt === 'object') {
      const { ignoreCodes } = diagnosticsOpt
      if (ignoreCodes) {
        Array.isArray(ignoreCodes) ? ignoreList.push(...ignoreCodes) : ignoreList.push(ignoreCodes)
      }
      diagnostics = {
        pretty: diagnosticsOpt.pretty ?? true,
        ignoreCodes: toDiagnosticCodeList(ignoreList),
        pathRegex: normalizeRegex(diagnosticsOpt.pathRegex),
        throws: !diagnosticsOpt.warnOnly,
      }
    } else {
      diagnostics = {
        ignoreCodes: diagnosticsOpt ? toDiagnosticCodeList(ignoreList) : [],
        pretty: true,
        throws: diagnosticsOpt,
      }
    }
    // stringifyContentPathRegex option
    const stringifyContentPathRegex = normalizeRegex(options.stringifyContentPathRegex)
    // parsed options
    const res: TsJestConfig = {
      tsConfig,
      packageJson,
      babelConfig,
      diagnostics,
      isolatedModules: !!options.isolatedModules,
      compiler: options.compiler ?? 'typescript',
      transformers,
      stringifyContentPathRegex,
    }

    this.logger.debug({ tsJestConfig: res }, 'normalized ts-jest config')

    return res
  }

  /**
   * @internal
   */
  get parsedTsConfig(): ParsedCommandLine {
    return this._parsedTsConfig
  }

  /**
   * Use by e2e, don't mark as internal
   */
  @Memoize()
  get versions(): Record<string, string> {
    const modules = ['jest', this.tsJest.compiler]
    if (this.tsJest.babelConfig) {
      modules.push('@babel/core', 'babel-jest')
    }

    return modules.reduce(
      (map, name) => {
        map[name] = getPackageVersion(name) ?? '-'

        return map
      },
      { 'ts-jest': MY_VERSION } as Record<string, string>,
    )
  }

  /**
   * @internal
   */
  @Memoize()
  private get _parsedTsConfig(): ParsedCommandLine {
    const {
      tsJest: { tsConfig },
    } = this
    const configFilePath = tsConfig?.kind === 'file' ? tsConfig.value : undefined
    const result = this.readTsConfig(
      tsConfig?.kind === 'inline' ? tsConfig.value : undefined,
      configFilePath,
      tsConfig == null,
    )
    // throw errors if any matching wanted diagnostics
    this.raiseDiagnostics(result.errors, configFilePath)

    this.logger.debug({ tsconfig: result }, 'normalized typescript config')

    return result
  }

  /**
   * @internal
   */
  @Memoize()
  get raiseDiagnostics(): (diagnostics: Diagnostic[], filePath?: string, logger?: Logger) => void | never {
    const {
      createTsError,
      filterDiagnostics,
      tsJest: {
        diagnostics: { throws },
      },
      compilerModule: { DiagnosticCategory },
    } = this

    return (diagnostics: Diagnostic[], filePath?: string, logger: Logger = this.logger): void | never => {
      const filteredDiagnostics = filterDiagnostics(diagnostics, filePath)
      if (!filteredDiagnostics.length) return
      const error = createTsError(filteredDiagnostics)
      // only throw if `warnOnly` and it is a warning or error
      const importantCategories = [DiagnosticCategory.Warning, DiagnosticCategory.Error]
      if (throws && filteredDiagnostics.some((d) => importantCategories.includes(d.category))) {
        throw error
      }
      logger.warn({ error }, error.message)
    }
  }

  /**
   * @internal
   */
  @Memoize()
  private get babel(): BabelConfig | undefined {
    const {
      tsJest: { babelConfig },
    } = this
    if (babelConfig == null) {
      this.logger.debug('babel is disabled')

      return undefined
    }
    let base: BabelConfig = { cwd: this.cwd }
    if (babelConfig.kind === 'file') {
      if (babelConfig.value) {
        if (extname(babelConfig.value) === '.js') {
          base = {
            ...base,
            ...require(babelConfig.value),
          }
        } else {
          base = {
            ...base,
            ...json5.parse(readFileSync(babelConfig.value, 'utf8')),
          }
        }
      }
    } else if (babelConfig.kind === 'inline') {
      base = { ...base, ...babelConfig.value }
    }

    this.logger.debug({ babelConfig: base }, 'normalized babel config via ts-jest option')

    return base
  }

  /**
   * This API can be used by custom transformers
   */
  @Memoize()
  get compilerModule(): TTypeScript {
    return importer.typescript(ImportReasons.TsJest, this.tsJest.compiler)
  }

  /**
   * @internal
   */
  @Memoize()
  get babelJestTransformer(): BabelJestTransformer | undefined {
    const { babel } = this
    if (!babel) return undefined

    this.logger.debug('creating babel-jest transformer')

    return importer.babelJest(ImportReasons.BabelJest).createTransformer(babel) as BabelJestTransformer
  }

  @Memoize()
  get tsCompiler(): TsCompiler {
    return createCompilerInstance(this)
  }

  /**
   * @internal
   */
  @Memoize()
  private get astTransformers(): AstTransformer {
    let astTransformers: AstTransformer = {
      before: [
        ...internalAstTransformers.map((transformer) => ({
          transformModule: transformer,
        })),
      ],
    }
    const { transformers } = this.tsJest
    if (transformers.before) {
      astTransformers = {
        before: [
          ...astTransformers.before,
          ...transformers.before.map((transformer) =>
            typeof transformer === 'string'
              ? {
                  transformModule: require(transformer),
                }
              : {
                  transformModule: require(transformer.path),
                  options: transformer.options,
                },
          ),
        ],
      }
    }
    if (transformers.after) {
      astTransformers = {
        ...astTransformers,
        after: transformers.after.map((transformer) =>
          typeof transformer === 'string'
            ? {
                transformModule: require(transformer),
              }
            : {
                transformModule: require(transformer.path),
                options: transformer.options,
              },
        ),
      }
    }
    if (transformers.afterDeclarations) {
      astTransformers = {
        ...astTransformers,
        afterDeclarations: transformers.afterDeclarations.map((transformer) =>
          typeof transformer === 'string'
            ? {
                transformModule: require(transformer),
              }
            : {
                transformModule: require(transformer.path),
                options: transformer.options,
              },
        ),
      }
    }

    return astTransformers
  }

  /**
   * @internal
   */
  @Memoize()
  get tsCustomTransformers(): CustomTransformers {
    let customTransformers: CustomTransformers = {
      before: this.astTransformers.before.map((t) => t.transformModule.factory(this, t.options)) as TransformerFactory<
        SourceFile
      >[],
    }
    if (this.astTransformers.after) {
      customTransformers = {
        ...customTransformers,
        after: this.astTransformers.after.map((t) => t.transformModule.factory(this, t.options)) as TransformerFactory<
          SourceFile
        >[],
      }
    }
    if (this.astTransformers.afterDeclarations) {
      customTransformers = {
        ...customTransformers,
        afterDeclarations: this.astTransformers.afterDeclarations.map((t) =>
          t.transformModule.factory(this, t.options),
        ) as TransformerFactory<Bundle | SourceFile>[],
      }
    }

    return customTransformers
  }

  /**
   * @internal
   */
  @Memoize()
  get hooks(): TsJestHooksMap {
    let hooksFile = process.env.TS_JEST_HOOKS
    if (hooksFile) {
      hooksFile = resolve(this.cwd, hooksFile)

      return importer.tryTheseOr(hooksFile, {})
    }

    return {}
  }

  /**
   * @internal
   */
  @Memoize()
  private get filterDiagnostics(): (diagnostics: Diagnostic[], filePath?: string) => Diagnostic[] {
    const {
      tsJest: {
        diagnostics: { ignoreCodes },
      },
      shouldReportDiagnostic,
    } = this

    return (diagnostics: Diagnostic[], filePath?: string): Diagnostic[] => {
      if (filePath && !shouldReportDiagnostic(filePath)) return []

      return diagnostics.filter((diagnostic) => {
        if (diagnostic.file?.fileName && !shouldReportDiagnostic(diagnostic.file.fileName)) {
          return false
        }

        return !ignoreCodes.includes(diagnostic.code)
      })
    }
  }

  /**
   * @internal
   */
  @Memoize()
  get shouldReportDiagnostic(): (filePath: string) => boolean {
    const {
      diagnostics: { pathRegex },
    } = this.tsJest
    if (pathRegex) {
      const regex = new RegExp(pathRegex)

      return (file: string): boolean => regex.test(file)
    } else {
      return (): true => true
    }
  }

  /**
   * @internal
   */
  @Memoize()
  get shouldStringifyContent(): (filePath: string) => boolean {
    const { stringifyContentPathRegex } = this.tsJest
    if (stringifyContentPathRegex) {
      const regex = new RegExp(stringifyContentPathRegex)

      return (file: string): boolean => regex.test(file)
    } else {
      return (): false => false
    }
  }

  /**
   * @internal
   */
  @Memoize()
  private get createTsError(): (diagnostics: readonly Diagnostic[]) => TSError {
    const {
      diagnostics: { pretty },
    } = this.tsJest

    const formatDiagnostics = pretty
      ? this.compilerModule.formatDiagnosticsWithColorAndContext
      : this.compilerModule.formatDiagnostics

    const diagnosticHost: FormatDiagnosticsHost = {
      getNewLine: () => '\n',
      getCurrentDirectory: () => this.cwd,
      getCanonicalFileName: (path: string) => path,
    }

    return (diagnostics: readonly Diagnostic[]): TSError => {
      const diagnosticText = formatDiagnostics(diagnostics, diagnosticHost)
      const diagnosticCodes = diagnostics.map((x) => x.code)

      return new TSError(diagnosticText, diagnosticCodes)
    }
  }

  /**
   * @internal
   */
  @Memoize()
  get tsCacheDir(): string | undefined {
    if (!this.jest.cache) {
      logger.debug('file caching disabled')

      return undefined
    }
    const cacheSuffix = sha1(
      stringify({
        version: this.compilerModule.version,
        digest: this.tsJestDigest,
        compiler: this.tsJest.compiler,
        compilerOptions: this.parsedTsConfig.options,
        isolatedModules: this.tsJest.isolatedModules,
        diagnostics: this.tsJest.diagnostics,
      }),
    )
    const res = join(this.jest.cacheDirectory, 'ts-jest', cacheSuffix.substr(0, 2), cacheSuffix.substr(2))

    logger.debug({ cacheDirectory: res }, 'will use file caching')

    return res
  }

  /**
   * @internal
   */
  @Memoize()
  private get overriddenCompilerOptions(): Partial<CompilerOptions> {
    const options: Partial<CompilerOptions> = {
      // we handle sourcemaps this way and not another
      sourceMap: true,
      inlineSourceMap: false,
      inlineSources: true,
      // we don't want to create declaration files
      declaration: false,
      noEmit: false, // set to true will make compiler API not emit any compiled results.
      // else istanbul related will be dropped
      removeComments: false,
      // to clear out else it's buggy
      out: undefined,
      outFile: undefined,
      composite: undefined, // see https://github.com/TypeStrong/ts-node/pull/657/files
      declarationDir: undefined,
      declarationMap: undefined,
      emitDeclarationOnly: undefined,
      sourceRoot: undefined,
      tsBuildInfoFile: undefined,
    }
    // force the module kind if not piping babel-jest
    if (!this.tsJest.babelConfig) {
      // commonjs is required for jest
      options.module = this.compilerModule.ModuleKind.CommonJS
    }

    return options
  }

  /**
   * @internal
   */
  @Memoize()
  get rootDir(): string {
    return normalize(this.jest.rootDir || this.cwd)
  }

  /**
   * @internal
   */
  @Memoize()
  get cwd(): string {
    return normalize(this.jest.cwd || process.cwd())
  }

  /**
   * Use by e2e, don't mark as internal
   */
  @Memoize()
  // eslint-disable-next-line class-methods-use-this
  get tsJestDigest(): string {
    return MY_DIGEST
  }

  /**
   * @internal
   */
  @Memoize()
  get jsonValue(): JsonableValue {
    const jest = { ...this.jest }
    const globals = (jest.globals = { ...jest.globals } as any)
    // we need to remove some stuff from jest config
    // this which does not depend on config
    jest.name = undefined as any
    jest.cacheDirectory = undefined as any
    // we do not need this since its normalized version is in tsJest
    delete globals['ts-jest']

    return new JsonableValue({
      digest: this.tsJestDigest,
      transformers: Object.values(this.astTransformers)
        .reduce((acc, val) => acc.concat(val), [])
        .map(({ transformModule }: AstTransformerObj) => `${transformModule.name}@${transformModule.version}`),
      jest,
      tsJest: this.tsJest,
      babel: this.babel,
      tsconfig: {
        options: this.parsedTsConfig.options,
        raw: this.parsedTsConfig.raw,
      },
    })
  }

  /**
   * @internal
   */
  get cacheKey(): string {
    return this.jsonValue.serialized
  }

  readonly logger: Logger
  /**
   * @internal
   */
  private readonly _jestConfig: Config.ProjectConfig

  constructor(jestConfig: Config.ProjectConfig, parentLogger?: Logger) {
    this._jestConfig = jestConfig
    this.logger = parentLogger ? parentLogger.child({ [LogContexts.namespace]: 'config' }) : logger
  }

  /**
   * @internal
   */
  private makeDiagnostic(
    code: number,
    messageText: string,
    options: { category?: DiagnosticCategory; file?: SourceFile; start?: number; length?: number } = {},
  ): Diagnostic {
    const { category = this.compilerModule.DiagnosticCategory.Warning, file, start, length } = options

    return {
      code,
      messageText,
      category,
      file,
      start,
      length,
    }
  }

  /**
   * @internal
   */
  private getInlineOrFileConfigOpt(
    configOpt: string | boolean | Record<string, any> | undefined,
  ): { kind: 'inline' | 'file'; value: any } | undefined {
    if (typeof configOpt === 'string' || configOpt === true) {
      return {
        kind: 'file',
        value: typeof configOpt === 'string' ? this.resolvePath(configOpt) : undefined,
      }
    } else if (typeof configOpt === 'object') {
      return {
        kind: 'inline',
        value: configOpt,
      }
    }

    return
  }

  /**
   * Load TypeScript configuration. Returns the parsed TypeScript config and
   * any `tsConfig` options specified in ts-jest tsConfig
   *
   * @internal
   */
  readTsConfig(
    compilerOptions?: CompilerOptions,
    resolvedConfigFile?: string | null,
    noProject?: boolean | null,
  ): ParsedCommandLine {
    let config = { compilerOptions: Object.create(null) }
    let basePath = normalizeSlashes(this.rootDir)
    let configFileName: string | undefined
    const ts = this.compilerModule

    if (!noProject) {
      // Read project configuration when available.
      configFileName = resolvedConfigFile
        ? normalizeSlashes(resolvedConfigFile)
        : ts.findConfigFile(normalizeSlashes(this.rootDir), ts.sys.fileExists)

      if (configFileName) {
        this.logger.debug({ tsConfigFileName: configFileName }, 'readTsConfig(): reading', configFileName)
        const result = ts.readConfigFile(configFileName, ts.sys.readFile)

        // Return diagnostics.
        if (result.error) {
          return { errors: [result.error], fileNames: [], options: {} }
        }

        config = result.config
        basePath = normalizeSlashes(dirname(configFileName))
      }
    }
    // Override default configuration options `ts-jest` requires.
    config.compilerOptions = {
      ...config.compilerOptions,
      ...compilerOptions,
    }

    // parse json, merge config extending others, ...
    const result = ts.parseJsonConfigFileContent(config, ts.sys, basePath, undefined, configFileName)

    const { overriddenCompilerOptions: forcedOptions } = this
    const finalOptions = result.options

    // Target ES5 output by default (instead of ES3).
    if (finalOptions.target === undefined) {
      finalOptions.target = ts.ScriptTarget.ES5
    }

    // check the module interoperability
    const target = finalOptions.target
    // compute the default if not set
    const defaultModule = [ts.ScriptTarget.ES3, ts.ScriptTarget.ES5].includes(target)
      ? ts.ModuleKind.CommonJS
      : ts.ModuleKind.ESNext
    const moduleValue = finalOptions.module == null ? defaultModule : finalOptions.module
    if (
      'module' in forcedOptions &&
      moduleValue !== forcedOptions.module &&
      !(finalOptions.esModuleInterop || finalOptions.allowSyntheticDefaultImports)
    ) {
      result.errors.push(
        this.makeDiagnostic(DiagnosticCodes.ConfigModuleOption, Errors.ConfigNoModuleInterop, {
          category: ts.DiagnosticCategory.Message,
        }),
      )
      // at least enable synthetic default imports (except if it's set in the input config)
      if (!('allowSyntheticDefaultImports' in config.compilerOptions)) {
        finalOptions.allowSyntheticDefaultImports = true
      }
    }
    // Make sure when allowJs is enabled, outDir is required to have when using allowJs: true
    if (finalOptions.allowJs && !finalOptions.outDir) {
      finalOptions.outDir = TS_JEST_OUT_DIR
    }

    // ensure undefined are removed and other values are overridden
    for (const key of Object.keys(forcedOptions)) {
      const val = forcedOptions[key]
      if (val === undefined) {
        delete finalOptions[key]
      } else {
        finalOptions[key] = val
      }
    }
    /**
     * See https://github.com/microsoft/TypeScript/wiki/Node-Target-Mapping
     * Every time this page is updated, we also need to update here. Here we only show warning message for Node LTS versions
     */
    const nodeJsVer = process.version
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const compilationTarget = result.options.target!
    if (
      !this.tsJest.babelConfig &&
      ((nodeJsVer.startsWith('v10') && compilationTarget > ScriptTarget.ES2018) ||
        (nodeJsVer.startsWith('v12') && compilationTarget > ScriptTarget.ES2019))
    ) {
      const message = interpolate(Errors.MismatchNodeTargetMapping, {
        nodeJsVer: process.version,
        compilationTarget: config.compilerOptions.target ?? TARGET_TO_VERSION_MAPPING[compilationTarget],
      })
      logger.warn(message)
    }

    return result
  }

  /**
   * @internal
   */
  resolvePath(
    inputPath: string,
    { throwIfMissing = true, nodeResolve = false }: { throwIfMissing?: boolean; nodeResolve?: boolean } = {},
  ): string {
    let path: string = inputPath
    let nodeResolved = false
    if (path.startsWith('<rootDir>')) {
      path = resolve(join(this.rootDir, path.substr(9)))
    } else if (!isAbsolute(path)) {
      if (!path.startsWith('.') && nodeResolve) {
        try {
          path = require.resolve(path)
          nodeResolved = true
        } catch (_) {}
      }
      if (!nodeResolved) {
        path = resolve(this.cwd, path)
      }
    }
    if (!nodeResolved && nodeResolve) {
      try {
        path = require.resolve(path)
        nodeResolved = true
      } catch (_) {}
    }
    if (throwIfMissing && !existsSync(path)) {
      throw new Error(interpolate(Errors.FileNotFound, { inputPath, resolvedPath: path }))
    }

    this.logger.debug({ fromPath: inputPath, toPath: path }, 'resolved path from', inputPath, 'to', path)

    return path
  }

  /**
   * @internal
   */
  toJSON(): any {
    return this.jsonValue.value
  }
}

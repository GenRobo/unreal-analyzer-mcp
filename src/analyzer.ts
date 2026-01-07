/**
 * Unreal Engine Code Analyzer
 * Pure regex-based implementation (no tree-sitter native modules)
 * 
 * Originally created by Ayelet Technology Private Limited
 * Refactored for portability
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';

interface ClassInfo {
  name: string;
  file: string;
  line: number;
  superclasses: string[];
  interfaces: string[];
  methods: MethodInfo[];
  properties: PropertyInfo[];
  comments: string[];
}

interface MethodInfo {
  name: string;
  returnType: string;
  parameters: ParameterInfo[];
  isVirtual: boolean;
  isOverride: boolean;
  visibility: 'public' | 'protected' | 'private';
  comments: string[];
  line: number;
}

interface ParameterInfo {
  name: string;
  type: string;
  defaultValue?: string;
}

interface PropertyInfo {
  name: string;
  type: string;
  visibility: 'public' | 'protected' | 'private';
  comments: string[];
  line: number;
}

interface CodeReference {
  file: string;
  line: number;
  column: number;
  context: string;
}

interface ClassHierarchy {
  className: string;
  superclasses: ClassHierarchy[];
  interfaces: string[];
}

interface SubsystemInfo {
  name: string;
  mainClasses: string[];
  keyFeatures: string[];
  dependencies: string[];
  sourceFiles: string[];
}

interface PatternInfo {
  name: string;
  description: string;
  bestPractices: string[];
  documentation: string;
  examples: string[];
  relatedPatterns: string[];
}

interface LearningResource {
  title: string;
  type: 'documentation' | 'tutorial' | 'video' | 'blog';
  url: string;
  description: string;
}

interface ApiReference {
  className: string;
  methodName?: string;
  propertyName?: string;
  description: string;
  syntax: string;
  parameters?: {
    name: string;
    type: string;
    description: string;
  }[];
  returnType?: string;
  returnDescription?: string;
  examples: string[];
  remarks: string[];
  relatedClasses: string[];
  category: string;
  module: string;
  version: string;
}

interface ApiQueryResult {
  reference: ApiReference;
  context: string;
  relevance: number;
  learningResources: LearningResource[];
}

interface CodePatternMatch {
  pattern: PatternInfo;
  file: string;
  line: number;
  context: string;
  suggestedImprovements?: string[];
  learningResources: LearningResource[];
}

export class UnrealCodeAnalyzer {
  private unrealPath: string | null = null;
  private customPath: string | null = null;
  private classCache: Map<string, ClassInfo> = new Map();
  private apiCache: Map<string, ApiReference> = new Map();
  private initialized: boolean = false;
  private readonly MAX_CACHE_SIZE = 50000;

  constructor() {}

  public isInitialized(): boolean {
    return this.initialized;
  }

  public async initialize(enginePath: string): Promise<void> {
    if (!fs.existsSync(enginePath)) {
      throw new Error('Invalid Unreal Engine path: Directory does not exist');
    }

    // Accept either Engine/Source or the root UE path
    const hasEngineDir = fs.existsSync(path.join(enginePath, 'Engine'));
    const hasSourceDir = fs.existsSync(path.join(enginePath, 'Source'));
    
    if (!hasEngineDir && !hasSourceDir) {
      throw new Error('Invalid Unreal Engine path: Neither Engine nor Source directory found');
    }

    this.unrealPath = enginePath;
    this.initialized = true;
    console.error(`Initialized with Unreal Engine path: ${enginePath}`);
  }

  public async initializeCustomCodebase(customPath: string): Promise<void> {
    if (!fs.existsSync(customPath)) {
      throw new Error('Invalid custom codebase path: Directory does not exist');
    }

    this.customPath = customPath;
    this.initialized = true;
    console.error(`Initialized with custom codebase path: ${customPath}`);
  }

  /**
   * Extract class info using regex - reliable for UE code with heavy macro usage
   */
  private extractClassInfoWithRegex(filePath: string, className: string): ClassInfo | null {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      
      // Pattern to match class definition line
      // Handles: class AActor : public UObject
      // Handles: class ENGINE_API AActor : public UObject  
      // Handles: class AActor final : public UObject
      const classDefPattern = new RegExp(
        `^\\s*(?:UCLASS\\s*\\([^)]*\\)\\s*)?class\\s+(?:\\w+_API\\s+)?${className}\\s*(?:final)?\\s*(?::\\s*(.+))?`,
        'i'
      );
      
      let classLine = -1;
      let inheritancePart = '';
      
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(classDefPattern);
        if (match) {
          classLine = i + 1;
          inheritancePart = match[1] || '';
          break;
        }
      }
      
      if (classLine === -1) {
        return null;
      }
      
      // Parse inheritance
      const superclasses: string[] = [];
      const interfaces: string[] = [];
      
      // Clean up the inheritance part (remove trailing { if present)
      inheritancePart = inheritancePart.replace(/\s*\{.*$/, '').trim();
      
      if (inheritancePart) {
        // Split by comma and parse each base class
        const baseClasses = inheritancePart.split(',').map(s => s.trim());
        for (const baseClass of baseClasses) {
          // Extract class name from "public ClassName" or "private ClassName"
          const baseMatch = baseClass.match(/(?:public|private|protected)\s+(\w+)/);
          if (baseMatch) {
            const baseName = baseMatch[1];
            // Interfaces typically start with 'I' and are not UObject-derived
            if (baseName.startsWith('I') && baseName !== 'IInterface' && !baseName.startsWith('Int')) {
              interfaces.push(baseName);
            } else {
              superclasses.push(baseName);
            }
          }
        }
      }
      
      // Extract methods (simplified)
      const methods: MethodInfo[] = [];
      const methodPattern = /^\s*(?:UFUNCTION\s*\([^)]*\)\s*)?(?:virtual\s+)?(?:static\s+)?(?:\w+_API\s+)?(\w+(?:<[^>]+>)?(?:\s*[*&])?)\s+(\w+)\s*\([^)]*\)\s*(?:const)?\s*(?:override)?/;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('DECLARE_') || line.includes('typedef') || line.includes('#define')) {
          continue;
        }
        const methodMatch = line.match(methodPattern);
        if (methodMatch) {
          methods.push({
            name: methodMatch[2],
            returnType: methodMatch[1],
            parameters: [],
            isVirtual: line.includes('virtual'),
            isOverride: line.includes('override'),
            visibility: 'public',
            comments: [],
            line: i + 1
          });
        }
      }
      
      // Extract properties (UPROPERTY decorated)
      const properties: PropertyInfo[] = [];
      const propPattern = /^\s*UPROPERTY\s*\([^)]*\)\s*\n?\s*(\w+(?:<[^>]+>)?(?:\s*[*&])?)\s+(\w+)/gm;
      let propMatch;
      while ((propMatch = propPattern.exec(content)) !== null) {
        const lineNum = content.substring(0, propMatch.index).split('\n').length;
        properties.push({
          name: propMatch[2],
          type: propMatch[1],
          visibility: 'public',
          comments: [],
          line: lineNum
        });
      }
      
      return {
        name: className,
        file: filePath,
        line: classLine,
        superclasses,
        interfaces,
        methods: methods.slice(0, 100),
        properties: properties.slice(0, 100),
        comments: []
      };
    } catch (error) {
      return null;
    }
  }

  public async analyzeClass(className: string): Promise<ClassInfo> {
    if (!this.initialized) {
      throw new Error('Analyzer not initialized');
    }

    // Check cache first
    const cachedInfo = this.classCache.get(className);
    if (cachedInfo) {
      return cachedInfo;
    }

    // Build list of paths to search
    const searchPaths: string[] = [];
    if (this.customPath) searchPaths.push(this.customPath);
    if (this.unrealPath) {
      // Add common UE source directories
      const ueDirs = [
        path.join(this.unrealPath, 'Engine/Source/Runtime'),
        path.join(this.unrealPath, 'Engine/Source/Editor'),
        path.join(this.unrealPath, 'Source/Runtime'),
        path.join(this.unrealPath, 'Source'),
        this.unrealPath
      ];
      for (const dir of ueDirs) {
        if (fs.existsSync(dir)) {
          searchPaths.push(dir);
        }
      }
    }
    
    if (searchPaths.length === 0) {
      throw new Error('No valid search path configured');
    }

    // Regex to find files that likely contain this class definition
    const classDefPattern = new RegExp(
      `\\bclass\\s+(?:\\w+_API\\s+)?${className}\\s*(?:final)?\\s*(?::|{)`,
      'i'
    );
    
    // Search each path
    for (const searchPath of searchPaths) {
      const files = await glob('**/*.h', {
        cwd: searchPath,
        absolute: true,
        ignore: ['**/*.generated.h', '**/Intermediate/**'],
      });

      // Scan files for the class
      for (const file of files) {
        try {
          const content = fs.readFileSync(file, 'utf8');
          if (classDefPattern.test(content)) {
            const classInfo = this.extractClassInfoWithRegex(file, className);
            if (classInfo) {
              this.classCache.set(className, classInfo);
              return classInfo;
            }
          }
        } catch (error) {
          // Skip unreadable files
        }
      }
    }

    throw new Error(`Class not found: ${className}`);
  }

  public async findClassHierarchy(
    className: string,
    includeInterfaces: boolean = true
  ): Promise<ClassHierarchy> {
    const classInfo = await this.analyzeClass(className);
    
    const hierarchy: ClassHierarchy = {
      className: classInfo.name,
      superclasses: [],
      interfaces: includeInterfaces ? classInfo.interfaces : [],
    };

    // Recursively build superclass hierarchies
    for (const superclass of classInfo.superclasses) {
      try {
        const superHierarchy = await this.findClassHierarchy(superclass, includeInterfaces);
        hierarchy.superclasses.push(superHierarchy);
      } catch (error) {
        // Superclass might not be found, add as leaf
        hierarchy.superclasses.push({
          className: superclass,
          superclasses: [],
          interfaces: []
        });
      }
    }

    return hierarchy;
  }

  public async findReferences(
    identifier: string,
    type?: 'class' | 'function' | 'variable'
  ): Promise<CodeReference[]> {
    if (!this.initialized) {
      throw new Error('Analyzer not initialized');
    }

    const searchPath = this.customPath || this.unrealPath;
    if (!searchPath) {
      throw new Error('No valid search path configured');
    }

    const files = await glob('**/*.{h,cpp}', {
      cwd: searchPath,
      absolute: true,
      ignore: ['**/Intermediate/**'],
    });

    const references: CodeReference[] = [];
    const identifierPattern = new RegExp(`\\b${identifier}\\b`, 'g');

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (identifierPattern.test(line)) {
            identifierPattern.lastIndex = 0; // Reset regex
            
            const context = lines
              .slice(Math.max(0, i - 2), i + 3)
              .join('\n');

            references.push({
              file,
              line: i + 1,
              column: line.indexOf(identifier) + 1,
              context,
            });
          }
        }
      } catch (error) {
        // Skip unreadable files
      }
    }

    return references.slice(0, 100); // Limit results
  }

  public async searchCode(
    query: string,
    filePattern: string = '*.{h,cpp}',
    includeComments: boolean = true
  ): Promise<CodeReference[]> {
    if (!this.initialized) {
      throw new Error('Analyzer not initialized');
    }

    if (!this.customPath && !this.unrealPath) {
      throw new Error('No valid search path configured');
    }

    const results: CodeReference[] = [];
    
    // Build list of search paths
    const searchPaths: string[] = [];
    
    // Check if searching for shaders
    const isShaderSearch = filePattern.includes('usf') || filePattern.includes('ush');
    
    if (this.customPath) {
      searchPaths.push(this.customPath);
    }
    
    if (this.unrealPath) {
      // Add UE source paths
      searchPaths.push(this.unrealPath);
      
      // Add Engine/Shaders for shader searches
      if (isShaderSearch) {
        const shaderPaths = [
          path.join(this.unrealPath, 'Engine', 'Shaders'),
          path.join(this.unrealPath, 'Shaders'),
        ];
        for (const sp of shaderPaths) {
          if (fs.existsSync(sp)) {
            searchPaths.push(sp);
          }
        }
      }
    }
    
    // Search all paths and collect files
    let allFiles: string[] = [];
    for (const searchPath of searchPaths) {
      const files = await glob(`**/${filePattern}`, {
        cwd: searchPath,
        absolute: true,
        ignore: ['**/Intermediate/**'],
      });
      allFiles = allFiles.concat(files);
    }
    
    // Deduplicate files
    const files = [...new Set(allFiles)];

    const regex = new RegExp(query, 'gi');

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          
          // Skip comment lines if not including comments
          if (!includeComments && (line.trim().startsWith('//') || line.trim().startsWith('/*'))) {
            continue;
          }

          if (regex.test(line)) {
            regex.lastIndex = 0;
            
            const context = lines
              .slice(Math.max(0, i - 2), i + 3)
              .join('\n');

            results.push({
              file,
              line: i + 1,
              column: line.search(regex) + 1,
              context,
            });
          }
        }
      } catch (error) {
        // Skip unreadable files
      }
    }

    return results.slice(0, 100);
  }

  private readonly UNREAL_PATTERNS: PatternInfo[] = [
    {
      name: 'UPROPERTY Macro',
      description: 'Property declaration for Unreal reflection system',
      bestPractices: [
        'Use appropriate property specifiers (EditAnywhere, BlueprintReadWrite, etc.)',
        'Consider replication needs (Replicated, ReplicatedUsing)',
        'Group related properties with categories'
      ],
      documentation: 'https://docs.unrealengine.com/5.0/en-US/unreal-engine-uproperty-specifier-reference/',
      examples: [
        'UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Combat")\nfloat Health;',
        'UPROPERTY(Replicated)\nFVector Location;'
      ],
      relatedPatterns: ['UFUNCTION Macro', 'UCLASS Macro']
    },
    {
      name: 'Component Setup',
      description: 'Creating and initializing components in constructor',
      bestPractices: [
        'Create components in constructor',
        'Set default values in constructor',
        'Use CreateDefaultSubobject for components',
        'Set root component appropriately'
      ],
      documentation: 'https://docs.unrealengine.com/5.0/en-US/components-in-unreal-engine/',
      examples: [
        'RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));',
        'MeshComponent = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Mesh"));'
      ],
      relatedPatterns: ['Actor Initialization', 'Component Registration']
    },
    {
      name: 'Event Binding',
      description: 'Binding to delegate events and implementing event handlers',
      bestPractices: [
        'Bind events in BeginPlay',
        'Unbind events in EndPlay',
        'Use DECLARE_DYNAMIC_MULTICAST_DELEGATE for Blueprint exposure',
        'Consider weak pointer bindings for safety'
      ],
      documentation: 'https://docs.unrealengine.com/5.0/en-US/delegates-in-unreal-engine/',
      examples: [
        'OnHealthChanged.AddDynamic(this, &AMyActor::HandleHealthChanged);',
        'FScriptDelegate Delegate; Delegate.BindUFunction(this, "OnCustomEvent");'
      ],
      relatedPatterns: ['Delegate Declaration', 'Event Dispatching']
    }
  ];

  public async detectPatterns(
    fileContent: string,
    filePath: string
  ): Promise<CodePatternMatch[]> {
    const matches: CodePatternMatch[] = [];
    const lines = fileContent.split('\n');

    const patternMatchers: { [key: string]: RegExp } = {
      'UPROPERTY Macro': /UPROPERTY\s*\([^)]*\)/,
      'Component Setup': /CreateDefaultSubobject\s*<[^>]+>\s*\(/,
      'Event Binding': /\.Add(Dynamic|Unique|Raw|Lambda)|BindUFunction/
    };

    for (const pattern of this.UNREAL_PATTERNS) {
      const matcher = patternMatchers[pattern.name];
      if (!matcher) continue;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (matcher.test(line)) {
          const context = lines
            .slice(Math.max(0, i - 2), Math.min(lines.length, i + 3))
            .join('\n');

          const suggestedImprovements = this.analyzePotentialImprovements(context, pattern);
          const learningResources = this.getLearningResources(pattern);

          matches.push({
            pattern,
            file: filePath,
            line: i + 1,
            context,
            suggestedImprovements,
            learningResources
          });
        }
      }
    }

    return matches;
  }

  private analyzePotentialImprovements(context: string, pattern: PatternInfo): string[] {
    const improvements: string[] = [];

    switch (pattern.name) {
      case 'UPROPERTY Macro':
        if (!context.includes('Category')) {
          improvements.push('Consider adding a Category specifier for better organization');
        }
        if (context.includes('BlueprintReadWrite') && !context.includes('Meta')) {
          improvements.push('Consider adding Meta specifiers for validation');
        }
        break;

      case 'Component Setup':
        if (!context.includes('RootComponent') && context.includes('CreateDefaultSubobject')) {
          improvements.push('Consider setting up component hierarchy');
        }
        break;

      case 'Event Binding':
        if (!context.toLowerCase().includes('beginplay') && !context.toLowerCase().includes('endplay')) {
          improvements.push('Consider managing event binding/unbinding in BeginPlay/EndPlay');
        }
        break;
    }

    return improvements;
  }

  private getLearningResources(pattern: PatternInfo): LearningResource[] {
    return [
      {
        title: 'Official Documentation',
        type: 'documentation',
        url: pattern.documentation,
        description: `Official Unreal Engine documentation for ${pattern.name}`
      }
    ];
  }

  public async queryApiReference(
    query: string,
    options: {
      category?: string;
      module?: string;
      includeExamples?: boolean;
      maxResults?: number;
    } = {}
  ): Promise<ApiQueryResult[]> {
    if (!this.initialized) {
      throw new Error('Analyzer not initialized');
    }

    const results: ApiQueryResult[] = [];
    const searchTerms = query.toLowerCase().split(/\s+/);

    // Search through cached classes
    for (const [className, classInfo] of this.classCache.entries()) {
      const apiRef = this.getOrCreateApiReference(classInfo);
      if (!apiRef) continue;

      // Filter by category/module if specified
      if (options.category && apiRef.category !== options.category) continue;
      if (options.module && apiRef.module !== options.module) continue;

      // Calculate relevance score
      const relevance = this.calculateApiRelevance(apiRef, searchTerms);
      if (relevance > 0) {
        const result: ApiQueryResult = {
          reference: apiRef,
          context: this.generateApiContext(apiRef, options.includeExamples),
          relevance,
          learningResources: this.getLearningResources({
            name: className,
            description: apiRef.description,
            bestPractices: apiRef.remarks,
            documentation: `https://dev.epicgames.com/documentation/en-us/unreal-engine/API/${apiRef.module}/${className}`,
            examples: apiRef.examples,
            relatedPatterns: apiRef.relatedClasses
          })
        };
        results.push(result);
      }
    }

    // Sort by relevance and limit results
    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, options.maxResults || 10);
  }

  private getOrCreateApiReference(classInfo: ClassInfo): ApiReference | null {
    if (this.apiCache.has(classInfo.name)) {
      return this.apiCache.get(classInfo.name)!;
    }

    const apiRef: ApiReference = {
      className: classInfo.name,
      description: `Class ${classInfo.name}`,
      syntax: this.generateClassSyntax(classInfo),
      examples: [],
      remarks: [],
      relatedClasses: [...classInfo.superclasses, ...classInfo.interfaces],
      category: this.determineCategory(classInfo),
      module: this.determineModule(classInfo.file),
      version: '5.0',
    };

    this.apiCache.set(classInfo.name, apiRef);
    return apiRef;
  }

  private calculateApiRelevance(apiRef: ApiReference, searchTerms: string[]): number {
    let score = 0;
    const text = [
      apiRef.className,
      apiRef.description,
      apiRef.category,
      apiRef.module,
      ...apiRef.relatedClasses,
    ].join(' ').toLowerCase();

    for (const term of searchTerms) {
      if (apiRef.className.toLowerCase().includes(term)) score += 10;
      if (apiRef.category.toLowerCase().includes(term)) score += 5;
      if (apiRef.module.toLowerCase().includes(term)) score += 5;
      if (text.includes(term)) score += 2;
    }

    return score;
  }

  private generateApiContext(apiRef: ApiReference, includeExamples: boolean = false): string {
    let context = `${apiRef.className} - ${apiRef.description}\n`;
    context += `Module: ${apiRef.module}\n`;
    context += `Category: ${apiRef.category}\n\n`;
    context += `Syntax:\n${apiRef.syntax}\n`;
    
    if (includeExamples && apiRef.examples.length > 0) {
      context += '\nExamples:\n';
      context += apiRef.examples.map(ex => `${ex}\n`).join('\n');
    }

    return context;
  }

  private generateClassSyntax(classInfo: ClassInfo): string {
    let syntax = `class ${classInfo.name}`;
    if (classInfo.superclasses.length > 0) {
      syntax += ` : public ${classInfo.superclasses.join(', public ')}`;
    }
    return syntax;
  }

  private determineCategory(classInfo: ClassInfo): string {
    if (classInfo.name.startsWith('U')) return 'Object';
    if (classInfo.name.startsWith('A')) return 'Actor';
    if (classInfo.name.startsWith('F')) return 'Structure';
    if (classInfo.superclasses.some(s => s.includes('Component'))) return 'Component';
    return 'Miscellaneous';
  }

  private determineModule(filePath: string): string {
    const parts = filePath.split(path.sep);
    const runtimeIndex = parts.indexOf('Runtime');
    if (runtimeIndex >= 0 && runtimeIndex + 1 < parts.length) {
      return parts[runtimeIndex + 1];
    }
    return 'Core';
  }

  public async analyzeSubsystem(subsystem: string): Promise<SubsystemInfo> {
    if (!this.initialized) {
      throw new Error('Analyzer not initialized');
    }

    if (!this.unrealPath) {
      throw new Error('Unreal Engine path not configured');
    }

    const subsystemInfo: SubsystemInfo = {
      name: subsystem,
      mainClasses: [],
      keyFeatures: [],
      dependencies: [],
      sourceFiles: [],
    };

    // Map subsystem names to their directories
    const subsystemDirs: { [key: string]: string } = {
      Rendering: 'Engine/Source/Runtime/RenderCore',
      Physics: 'Engine/Source/Runtime/PhysicsCore',
      Audio: 'Engine/Source/Runtime/AudioCore',
      Networking: 'Engine/Source/Runtime/Networking',
      Input: 'Engine/Source/Runtime/InputCore',
      AI: 'Engine/Source/Runtime/AIModule',
      Animation: 'Engine/Source/Runtime/AnimationCore',
      UI: 'Engine/Source/Runtime/UMG',
    };

    const subsystemDir = subsystemDirs[subsystem];
    if (!subsystemDir) {
      throw new Error(`Unknown subsystem: ${subsystem}`);
    }

    const fullPath = path.join(this.unrealPath, subsystemDir);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Subsystem directory not found: ${fullPath}`);
    }

    // Get all source files
    subsystemInfo.sourceFiles = await glob('**/*.{h,cpp}', {
      cwd: fullPath,
      absolute: true,
    });

    // Extract class names from header files using regex
    const headerFiles = subsystemInfo.sourceFiles.filter(f => f.endsWith('.h'));
    const classPattern = /\bclass\s+(?:\w+_API\s+)?(\w+)\s*(?:final)?\s*:/g;

    for (const file of headerFiles) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        let match;
        while ((match = classPattern.exec(content)) !== null) {
          subsystemInfo.mainClasses.push(match[1]);
        }
      } catch (error) {
        // Skip unreadable files
      }
    }

    return subsystemInfo;
  }
}

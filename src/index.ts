#!/usr/bin/env node
/**
 * Created by Ayelet Technology Private Limited
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { UnrealCodeAnalyzer } from './analyzer.js';
import { GAME_GENRES, GameGenre, GenreFlag } from './types/game-genres.js';
import { searchDocs, fetchDocPage, getClassDocumentation, searchDocsViaGoogle, closeBrowser } from './docs-search.js';

class UnrealAnalyzerServer {
  private server: Server;
  private analyzer: UnrealCodeAnalyzer;

  constructor() {
    this.server = new Server(
      {
        name: 'unreal-analyzer',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.analyzer = new UnrealCodeAnalyzer();
    this.setupToolHandlers();
    
    this.server.onerror = (error: Error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await closeBrowser();
      await this.server.close();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await closeBrowser();
      await this.server.close();
      process.exit(0);
    });
  }

  // Public method for auto-initialization from env vars
  async initializePaths(unrealPath?: string, customPath?: string) {
    if (unrealPath) {
      await this.analyzer.initialize(unrealPath);
    }
    if (customPath) {
      await this.analyzer.initializeCustomCodebase(customPath);
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'set_unreal_path',
          description: 'Set the path to Unreal Engine source code',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Absolute path to Unreal Engine source directory',
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'set_custom_codebase',
          description: 'Set the path to a custom C++ codebase for analysis',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Absolute path to custom codebase directory',
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'analyze_class',
          description: 'Get detailed information about a C++ class',
          inputSchema: {
            type: 'object',
            properties: {
              className: {
                type: 'string',
                description: 'Name of the class to analyze',
              },
            },
            required: ['className'],
          },
        },
        {
          name: 'find_class_hierarchy',
          description: 'Get the inheritance hierarchy for a class',
          inputSchema: {
            type: 'object',
            properties: {
              className: {
                type: 'string',
                description: 'Name of the class to analyze',
              },
              includeImplementedInterfaces: {
                type: 'boolean',
                description: 'Whether to include implemented interfaces',
                default: true,
              },
            },
            required: ['className'],
          },
        },
        {
          name: 'find_references',
          description: 'Find all references to a class, function, or variable',
          inputSchema: {
            type: 'object',
            properties: {
              identifier: {
                type: 'string',
                description: 'Name of the symbol to find references for',
              },
              type: {
                type: 'string',
                description: 'Type of symbol (class, function, variable)',
                enum: ['class', 'function', 'variable'],
              },
            },
            required: ['identifier'],
          },
        },
        {
          name: 'search_code',
          description: 'Search through code with context. Supports C++ headers, source files, and HLSL shaders.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query (supports regex)',
              },
              filePattern: {
                type: 'string',
                description: 'File pattern to search in. Examples: *.h, *.cpp, *.{h,cpp}, *.{usf,ush} for shaders',
                default: '*.{h,cpp}',
              },
              includeComments: {
                type: 'boolean',
                description: 'Whether to include comments in search',
                default: true,
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'detect_patterns',
          description: 'Detect Unreal Engine patterns and suggest improvements',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description: 'Path to the file to analyze',
              },
            },
            required: ['filePath'],
          },
        },
        {
          name: 'get_best_practices',
          description: 'Get Unreal Engine best practices and documentation for a specific concept',
          inputSchema: {
            type: 'object',
            properties: {
              concept: {
                type: 'string',
                description: 'Concept to get best practices for (e.g. UPROPERTY, Components, Events)',
                enum: ['UPROPERTY', 'UFUNCTION', 'Components', 'Events', 'Replication', 'Blueprints'],
              },
            },
            required: ['concept'],
          },
        },
        {
          name: 'analyze_subsystem',
          description: 'Analyze a specific Unreal Engine subsystem',
          inputSchema: {
            type: 'object',
            properties: {
              subsystem: {
                type: 'string',
                description: 'Name of the subsystem (e.g. Rendering, Physics)',
                enum: [
                  'Rendering',
                  'Physics',
                  'Audio',
                  'Networking',
                  'Input',
                  'AI',
                  'Animation',
                  'UI',
                ],
              },
            },
            required: ['subsystem'],
          },
        },
        {
          name: 'query_api',
          description: 'Search and retrieve Unreal Engine API documentation',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query for API documentation',
              },
              category: {
                type: 'string',
                description: 'Filter by category (Object, Actor, Structure, Component)',
                enum: ['Object', 'Actor', 'Structure', 'Component', 'Miscellaneous'],
              },
              module: {
                type: 'string',
                description: 'Filter by module (Core, RenderCore, etc.)',
              },
              includeExamples: {
                type: 'boolean',
                description: 'Include code examples in results',
                default: true,
              },
              maxResults: {
                type: 'number',
                description: 'Maximum number of results to return',
                default: 10,
              },
            },
            required: ['query'],
          },
        },
        // Online Documentation Search Tools
        {
          name: 'search_ue_docs',
          description: 'Search Unreal Engine online documentation at dev.epicgames.com. Uses browser automation to fetch results.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query for documentation',
              },
              version: {
                type: 'string',
                description: 'UE version (e.g., "5.7")',
                default: '5.7',
              },
              maxResults: {
                type: 'number',
                description: 'Maximum number of results to return',
                default: 10,
              },
              useGoogle: {
                type: 'boolean',
                description: 'Use Google search as fallback (more reliable)',
                default: false,
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_ue_doc_page',
          description: 'Fetch and parse a specific Unreal Engine documentation page by URL.',
          inputSchema: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'Full URL of the documentation page to fetch',
              },
            },
            required: ['url'],
          },
        },
        {
          name: 'get_class_docs',
          description: 'Get online documentation for a specific UE class (e.g., UPrimitiveComponent, AActor).',
          inputSchema: {
            type: 'object',
            properties: {
              className: {
                type: 'string',
                description: 'Name of the class to look up',
              },
              version: {
                type: 'string',
                description: 'UE version (e.g., "5.7")',
                default: '5.7',
              },
            },
            required: ['className'],
          },
        },
        {
          name: 'search_google',
          description: 'Search Google for Unreal Engine related topics (very reliable fallback)',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query',
              },
              maxResults: {
                type: 'number',
                description: 'Maximum number of results to return',
                default: 5,
              },
            },
            required: ['query'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
      // Only check for initialization for analysis tools
      const analysisTools = ['analyze_class', 'find_class_hierarchy', 'find_references', 'search_code', 'analyze_subsystem', 'query_api'];
      if (analysisTools.includes(request.params.name) && !this.analyzer.isInitialized() && 
          request.params.name !== 'set_unreal_path' && request.params.name !== 'set_custom_codebase') {
        throw new Error('No codebase initialized. Use set_unreal_path or set_custom_codebase first.');
      }

      switch (request.params.name) {
        case 'detect_patterns':
          return this.handleDetectPatterns(request.params.arguments);
        case 'get_best_practices':
          return this.handleGetBestPractices(request.params.arguments);
        case 'set_unreal_path':
          return this.handleSetUnrealPath(request.params.arguments);
        case 'set_custom_codebase':
          return this.handleSetCustomCodebase(request.params.arguments);
        case 'analyze_class':
          return this.handleAnalyzeClass(request.params.arguments);
        case 'find_class_hierarchy':
          return this.handleFindClassHierarchy(request.params.arguments);
        case 'find_references':
          return this.handleFindReferences(request.params.arguments);
        case 'search_code':
          return this.handleSearchCode(request.params.arguments);
        case 'analyze_subsystem':
          return this.handleAnalyzeSubsystem(request.params.arguments);
        case 'query_api':
          return this.handleQueryApi(request.params.arguments);
        case 'search_ue_docs':
          return this.handleSearchUEDocs(request.params.arguments);
        case 'get_ue_doc_page':
          return this.handleGetUEDocPage(request.params.arguments);
        case 'get_class_docs':
          return this.handleGetClassDocs(request.params.arguments);
        case 'search_google':
          return this.handleSearchGoogle(request.params.arguments);
        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }
    });
  }

  private async handleSearchGoogle(args: any) {
    try {
      const results = await searchDocsViaGoogle(args.query, args.maxResults);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ query: args.query, results }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to search Google');
    }
  }

  private async handleSetUnrealPath(args: any) {
    try {
      await this.analyzer.initialize(args.path);
      return {
        content: [
          {
            type: 'text',
            text: `Successfully set Unreal Engine path to: ${args.path}`,
          },
        ],
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to set Unreal Engine path');
    }
  }

  private async handleSetCustomCodebase(args: any) {
    try {
      await this.analyzer.initializeCustomCodebase(args.path);
      return {
        content: [
          {
            type: 'text',
            text: `Successfully set custom codebase path to: ${args.path}`,
          },
        ],
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to set custom codebase path');
    }
  }

  private async handleAnalyzeClass(args: any) {
    try {
      const classInfo = await this.analyzer.analyzeClass(args.className);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(classInfo, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to analyze class');
    }
  }

  private async handleFindClassHierarchy(args: any) {
    try {
      const hierarchy = await this.analyzer.findClassHierarchy(
        args.className,
        args.includeImplementedInterfaces
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(hierarchy, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to find class hierarchy');
    }
  }

  private async handleFindReferences(args: any) {
    try {
      const references = await this.analyzer.findReferences(
        args.identifier,
        args.type
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(references, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to find references');
    }
  }

  private async handleSearchCode(args: any) {
    try {
      const results = await this.analyzer.searchCode(
        args.query,
        args.filePattern,
        args.includeComments
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to search code');
    }
  }

  private async handleDetectPatterns(args: any) {
    try {
      const fileContent = await require('fs').promises.readFile(args.filePath, 'utf8');
      const patterns = await this.analyzer.detectPatterns(fileContent, args.filePath);
      
      // Format the output to be more readable in Cline
      const formattedPatterns = patterns.map(match => {
        return {
          pattern: match.pattern.name,
          description: match.pattern.description,
          location: `${match.file}:${match.line}`,
          context: match.context,
          improvements: match.suggestedImprovements?.join('\n'),
          documentation: match.pattern.documentation,
          bestPractices: match.pattern.bestPractices.join('\n'),
          examples: match.pattern.examples.join('\n'),
        };
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(formattedPatterns, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to detect patterns');
    }
  }

  private async handleGetBestPractices(args: any) {
    // Best practices content - documentation URLs are dynamic via search
    const DOCS_BASE = 'https://dev.epicgames.com/documentation/en-us/unreal-engine';
    const SEARCH_BASE = 'https://dev.epicgames.com/community/search?q=';
    
    const bestPractices: { [key: string]: any } = {
      'UPROPERTY': {
        description: 'Property declaration for Unreal reflection system',
        searchTerms: ['UPROPERTY specifier', 'property reflection'],
        bestPractices: [
          'Use appropriate specifiers (EditAnywhere, BlueprintReadWrite)',
          'Consider replication needs (Replicated, ReplicatedUsing)',
          'Group related properties with categories',
          'Use Meta tags for validation and UI customization',
          'Use UPROPERTY() for any member that needs GC, serialization, or Blueprint access',
        ],
        commonSpecifiers: [
          'EditAnywhere - editable in property windows',
          'BlueprintReadWrite - read/write from Blueprint',
          'BlueprintReadOnly - read-only from Blueprint',
          'VisibleAnywhere - visible but not editable',
          'Replicated - replicated over network',
          'ReplicatedUsing=FuncName - callback on replication',
          'Transient - not serialized',
          'Category="Name" - organize in editor',
        ],
        examples: [
          'UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Combat")\nfloat Health = 100.0f;',
          'UPROPERTY(Replicated, Meta = (ClampMin = "0.0", ClampMax = "1.0"))\nfloat Speed;',
          'UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Components")\nUStaticMeshComponent* MeshComponent;',
        ],
        searchUrl: `${SEARCH_BASE}UPROPERTY+specifier+unreal+engine`,
      },
      'UFUNCTION': {
        description: 'Function declaration for Unreal reflection system',
        searchTerms: ['UFUNCTION specifier', 'function reflection'],
        bestPractices: [
          'Use BlueprintCallable for functions that can be called from Blueprints',
          'Use BlueprintPure for functions without side effects (const, no exec pin)',
          'Use BlueprintNativeEvent for C++ functions overridable in Blueprint',
          'Use BlueprintImplementableEvent for Blueprint-only implementation',
          'Add Category and DisplayName for better Blueprint organization',
        ],
        commonSpecifiers: [
          'BlueprintCallable - callable from Blueprint',
          'BlueprintPure - no side effects, no exec pin',
          'BlueprintNativeEvent - overridable in Blueprint with C++ default',
          'BlueprintImplementableEvent - implemented only in Blueprint',
          'Server/Client/NetMulticast - RPC specifiers',
          'Reliable/Unreliable - RPC reliability',
          'WithValidation - RPC validation function',
        ],
        examples: [
          'UFUNCTION(BlueprintCallable, Category = "Combat")\nvoid TakeDamage(float DamageAmount);',
          'UFUNCTION(BlueprintPure, Category = "Stats")\nfloat GetHealthPercentage() const;',
          'UFUNCTION(BlueprintNativeEvent, Category = "Events")\nvoid OnDeath();',
          'UFUNCTION(Server, Reliable, WithValidation)\nvoid ServerFireWeapon();',
        ],
        searchUrl: `${SEARCH_BASE}UFUNCTION+specifier+unreal+engine`,
      },
      'Components': {
        description: 'Component setup and management in Unreal Engine',
        searchTerms: ['UActorComponent', 'CreateDefaultSubobject'],
        bestPractices: [
          'Create components in constructor using CreateDefaultSubobject<T>()',
          'Set RootComponent first, then attach others with SetupAttachment()',
          'Use UPROPERTY() for components that need Blueprint access',
          'Consider component tick settings for performance',
          'Use VisibleAnywhere for components, not EditAnywhere',
        ],
        componentTypes: [
          'USceneComponent - base for transform hierarchy',
          'UStaticMeshComponent - static 3D meshes',
          'USkeletalMeshComponent - animated meshes',
          'UCapsuleComponent - collision capsule',
          'UBoxComponent - collision box',
          'USphereComponent - collision sphere',
          'UAudioComponent - 3D audio',
          'UPointLightComponent - point lights',
        ],
        examples: [
          '// In constructor:\nMeshComponent = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Mesh"));\nRootComponent = MeshComponent;',
          'CollisionComponent = CreateDefaultSubobject<UCapsuleComponent>(TEXT("Collision"));\nCollisionComponent->SetupAttachment(RootComponent);',
          '// Component property declaration:\nUPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Components")\nUStaticMeshComponent* MeshComponent;',
        ],
        searchUrl: `${SEARCH_BASE}components+CreateDefaultSubobject+unreal+engine`,
      },
      'Events': {
        description: 'Event handling and delegation in Unreal Engine',
        searchTerms: ['delegates', 'multicast delegate', 'event dispatcher'],
        bestPractices: [
          'Bind events in BeginPlay, unbind in EndPlay to avoid dangling references',
          'Use AddDynamic/RemoveDynamic for dynamic delegates (Blueprint-compatible)',
          'Use AddUObject for C++-only delegates (slightly faster)',
          'Check IsValid() before broadcasting if delegate might be unbound',
          'Use BlueprintAssignable for events that should be bindable in Blueprint',
        ],
        delegateTypes: [
          'DECLARE_DELEGATE - single binding, C++ only',
          'DECLARE_MULTICAST_DELEGATE - multiple bindings, C++ only',
          'DECLARE_DYNAMIC_DELEGATE - single binding, Blueprint compatible',
          'DECLARE_DYNAMIC_MULTICAST_DELEGATE - multiple bindings, Blueprint compatible (most common)',
        ],
        examples: [
          '// Declaration:\nDECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnHealthChanged, float, NewHealth);\n\nUPROPERTY(BlueprintAssignable, Category = "Events")\nFOnHealthChanged OnHealthChanged;',
          '// Binding in BeginPlay:\nHealthComponent->OnHealthChanged.AddDynamic(this, &AMyActor::HandleHealthChanged);',
          '// Unbinding in EndPlay:\nHealthComponent->OnHealthChanged.RemoveDynamic(this, &AMyActor::HandleHealthChanged);',
          '// Broadcasting:\nOnHealthChanged.Broadcast(NewHealth);',
        ],
        searchUrl: `${SEARCH_BASE}delegates+events+unreal+engine`,
      },
      'Replication': {
        description: 'Network replication in Unreal Engine',
        searchTerms: ['network replication', 'replicated property', 'RPC'],
        bestPractices: [
          'Mark properties with Replicated or ReplicatedUsing specifier',
          'Implement GetLifetimeReplicatedProps() for replicated properties',
          'Use DOREPLIFETIME or DOREPLIFETIME_CONDITION macros',
          'Consider replication conditions (COND_OwnerOnly, COND_SkipOwner, etc.)',
          'Use Reliable RPCs sparingly - prefer Unreliable for frequent calls',
          'Validate RPC parameters on server with WithValidation',
        ],
        replicationConditions: [
          'COND_None - always replicate',
          'COND_InitialOnly - only on initial replication',
          'COND_OwnerOnly - only to owning connection',
          'COND_SkipOwner - to all except owner',
          'COND_SimulatedOnly - only to simulated proxies',
          'COND_AutonomousOnly - only to autonomous proxy',
        ],
        examples: [
          '// Property declaration:\nUPROPERTY(ReplicatedUsing = OnRep_Health)\nfloat Health;',
          '// GetLifetimeReplicatedProps:\nvoid AMyActor::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const\n{\n  Super::GetLifetimeReplicatedProps(OutLifetimeProps);\n  DOREPLIFETIME(AMyActor, Health);\n}',
          '// OnRep function:\nvoid AMyActor::OnRep_Health()\n{\n  UpdateHealthUI();\n}',
          '// Server RPC:\nUFUNCTION(Server, Reliable, WithValidation)\nvoid ServerTakeDamage(float Damage);',
        ],
        searchUrl: `${SEARCH_BASE}network+replication+unreal+engine`,
      },
      'Blueprints': {
        description: 'Blueprint integration and C++ exposure',
        searchTerms: ['Blueprint integration', 'BlueprintType', 'Blueprintable'],
        bestPractices: [
          'Use UCLASS(Blueprintable) for classes that can be subclassed in Blueprint',
          'Use UCLASS(BlueprintType) for classes usable as variable types',
          'Add DisplayName and Category meta tags for better organization',
          'Use BlueprintNativeEvent for virtual functions with C++ defaults',
          'Expose only what Blueprint needs - keep implementation details in C++',
        ],
        classSpecifiers: [
          'Blueprintable - can be subclassed by Blueprint',
          'BlueprintType - can be used as variable type',
          'NotBlueprintable - explicitly prevent Blueprint subclassing',
          'Abstract - cannot be instantiated directly',
          'MinimalAPI - minimal reflection, faster compile',
        ],
        examples: [
          'UCLASS(Blueprintable, BlueprintType)\nclass MYGAME_API AMyActor : public AActor\n{\n  GENERATED_BODY()\npublic:\n  UPROPERTY(EditAnywhere, BlueprintReadWrite)\n  float Health;\n};',
          '// Blueprint implementable event:\nUFUNCTION(BlueprintImplementableEvent, Category = "Events")\nvoid OnPickedUp();',
          '// Blueprint native event with C++ default:\nUFUNCTION(BlueprintNativeEvent, Category = "Combat")\nvoid OnDeath();\nvoid OnDeath_Implementation() { /* C++ default */ }',
        ],
        searchUrl: `${SEARCH_BASE}Blueprint+integration+C%2B%2B+unreal+engine`,
      },
    };

    const concept = bestPractices[args.concept];
    if (!concept) {
      throw new Error(`Unknown concept: ${args.concept}. Available: ${Object.keys(bestPractices).join(', ')}`);
    }

    // Add a note about searching for more docs
    concept.note = 'Use search_ue_docs tool with the searchTerms above to find current documentation pages.';

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(concept, null, 2),
        },
      ],
    };
  }

  private async handleAnalyzeSubsystem(args: any) {
    try {
      const subsystemInfo = await this.analyzer.analyzeSubsystem(args.subsystem);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(subsystemInfo, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to analyze subsystem');
    }
  }

  private async handleQueryApi(args: any) {
    try {
      const results = await this.analyzer.queryApiReference(args.query, {
        category: args.category,
        module: args.module,
        includeExamples: args.includeExamples,
        maxResults: args.maxResults,
      });

      // Format results for better readability
      const formattedResults = results.map(result => ({
        class: result.reference.className,
        description: result.reference.description,
        module: result.reference.module,
        category: result.reference.category,
        syntax: result.reference.syntax,
        examples: result.reference.examples,
        remarks: result.reference.remarks,
        documentation: result.learningResources[0]?.url,
        relevance: result.relevance,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(formattedResults, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to query API documentation');
    }
  }

  // Online Documentation Search Handlers
  private async handleSearchUEDocs(args: any) {
    try {
      const results = args.useGoogle
        ? await searchDocsViaGoogle(args.query, args.maxResults || 10)
        : await searchDocs(args.query, args.version || '5.7', args.maxResults || 10);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                query: args.query,
                resultCount: results.length,
                results: results,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to search UE docs');
    }
  }

  private async handleGetUEDocPage(args: any) {
    try {
      const page = await fetchDocPage(args.url);
      if (!page) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'Failed to fetch page', url: args.url }, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                title: page.title,
                url: page.url,
                headings: page.headings,
                codeBlockCount: page.codeBlocks.length,
                contentPreview: page.content.substring(0, 2000) + (page.content.length > 2000 ? '...' : ''),
                codeBlocks: page.codeBlocks.slice(0, 5),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to fetch doc page');
    }
  }

  private async handleGetClassDocs(args: any) {
    try {
      const page = await getClassDocumentation(args.className, args.version || '5.7');
      if (!page) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { error: `No documentation found for class: ${args.className}` },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                className: args.className,
                title: page.title,
                url: page.url,
                headings: page.headings,
                contentPreview: page.content.substring(0, 3000) + (page.content.length > 3000 ? '...' : ''),
                codeBlocks: page.codeBlocks.slice(0, 5),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to get class docs');
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Unreal Engine Analyzer MCP server running on stdio');
  }
}

const server = new UnrealAnalyzerServer();

// Auto-initialize from environment variables if provided
async function initFromEnv() {
  const unrealPath = process.env.UNREAL_ENGINE_PATH;
  const customPath = process.env.UNREAL_CUSTOM_CODEBASE;
  
  if (unrealPath) {
    console.error(`[unreal-analyzer] Auto-initializing Unreal Engine path: ${unrealPath}`);
    try {
      await server.initializePaths(unrealPath, customPath);
      console.error(`[unreal-analyzer] Auto-initialization complete`);
    } catch (error) {
      console.error(`[unreal-analyzer] Auto-initialization failed:`, error);
    }
  }
}

server.run().then(() => initFromEnv()).catch(console.error);

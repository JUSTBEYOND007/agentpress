/** @type {import('dependency-cruiser').IConfig} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'AgentPress modules must not contain import cycles.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'domain-only-internal-imports',
      severity: 'error',
      comment: 'The domain layer may only import its own domain modules.',
      from: { path: '^packages/domain/src' },
      to: { pathNot: '^packages/domain/src' },
    },
    {
      name: 'no-workspace-deep-import',
      severity: 'error',
      comment: 'Workspace packages are consumed through their public root export.',
      from: { path: '^(packages|apps)/' },
      to: { path: 'node_modules/@agentpress/.+/(src|test)/' },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.base.json' },
    doNotFollow: { path: 'node_modules' },
    moduleSystems: ['es6'],
    enhancedResolveOptions: { exportsFields: ['exports'] },
  },
};

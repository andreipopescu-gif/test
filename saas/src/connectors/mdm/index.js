import { addigyProvider } from './addigy.js';
import { googleChromeOsProvider } from './google-chromeos.js';
import { hexnodeProvider } from './hexnode.js';
import { jumpcloudProvider } from './jumpcloud.js';
import { kandjiProvider } from './kandji.js';
import { manageengineProvider } from './manageengine.js';
import { mosyleProvider } from './mosyle.js';
import { ninjaoneProvider } from './ninjaone.js';
import { sotiProvider } from './soti.js';
import { workspaceOneProvider } from './workspace-one.js';

export const extraMdmProviders = [
  kandjiProvider,
  mosyleProvider,
  workspaceOneProvider,
  googleChromeOsProvider,
  jumpcloudProvider,
  ninjaoneProvider,
  manageengineProvider,
  hexnodeProvider,
  addigyProvider,
  sotiProvider
];

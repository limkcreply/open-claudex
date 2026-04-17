import React from 'react';
import { Box, Text } from 'src/ink.js';

const WELCOME_V2_WIDTH = 58;

export function WelcomeV2() {
  return (
    <Box width={WELCOME_V2_WIDTH} flexDirection="column">
      <Text><Text color="claude">{"Welcome to Claudex"} </Text><Text dimColor={true}>v{MACRO.VERSION} </Text></Text>
      <Text>{"\u2026".repeat(WELCOME_V2_WIDTH)}</Text>
      <Text>{""}</Text>
      <Text color="clawd_body">{"     ▐▘      ▝▌"}</Text>
      <Text color="clawd_body">{"     ▝████████▘"}</Text>
      <Text color="clawd_body">{"   ▗▄ █ ████ █ ▄▖"}</Text>
      <Text color="clawd_body">{"   ▐████▙▀▀▟████▌"}</Text>
      <Text color="clawd_body">{"     ▐████████▌"}</Text>
      <Text color="clawd_body">{"    ▗▟        ▙▖"}</Text>
      <Text>{""}</Text>
      <Text>{"\u2026".repeat(WELCOME_V2_WIDTH)}</Text>
    </Box>
  );
}

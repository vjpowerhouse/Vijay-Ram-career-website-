#!/bin/sh
# Wraps src/content.html in a full HTML document for GitHub Pages.
set -e
{
  printf '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
  cat src/content.html
  printf '\n</html>\n'
} > index.html

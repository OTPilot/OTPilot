VERSION := $(shell grep '"version"' manifest.json | awk -F'"' '{print $$4}')
ZIP     := releases/otpilot-$(VERSION).zip
ZIP_DEV := releases/otpilot-$(VERSION)-dev.zip

EXTENSION_FILES := \
  manifest.json \
  popup.html popup.js \
  background.js \
  jsqr.js content.js totp.js \
  supabase.js cloudSync.js \
  config.js links.js \
  icon16.png icon48.png icon128.png \
  LICENSE

.PHONY: dev prod zip zip_dev

dev:
	@cp config-dev.js config.js
	@echo "config.js ← config-dev.js"

prod:
	@cp config-prod.js config.js
	@echo "config.js ← config-prod.js"

zip: prod
	@mkdir -p releases
	@rm -f $(ZIP)
	zip $(ZIP) $(EXTENSION_FILES)
	@echo "→ $(ZIP)"
	@$(MAKE) dev

zip_dev: dev
	@mkdir -p releases
	@rm -f $(ZIP_DEV)
	zip $(ZIP_DEV) $(EXTENSION_FILES)
	@echo "→ $(ZIP_DEV)"

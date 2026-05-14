VERSION := $(shell grep '"version"' manifest.json | awk -F'"' '{print $$4}')
ZIP     := releases/otpilot-$(VERSION).zip

.PHONY: zip deploy release

zip:
	@mkdir -p releases
	@rm -f $(ZIP)
	zip -r $(ZIP) \
	  manifest.json \
	  popup.html popup.js \
	  content.js totp.js \
	  icon16.png icon48.png icon128.png \
	  LICENSE
	@echo "→ $(ZIP)"

deploy:
	cd docs && vercel --prod

release: zip deploy

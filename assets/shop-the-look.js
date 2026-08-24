/**
 * Shop the Look
 * ---------------------------------------------------------------------------
 * Vanilla JS controller for the "Shop the look" section.
 *
 * Responsibilities:
 *  - Open a shared <dialog> quick-view popup when a hotspot is clicked.
 *  - Fetch product data via the Storefront AJAX API (/products/{handle}.js)
 *    and render name, price, description and variant pickers dynamically.
 *  - Track the selected options and resolve the matching variant.
 *  - Add the resolved variant to the cart via /cart/add.js.
 *  - Refresh Dawn's cart drawer / cart icon bubble without a page reload.
 *
 * Also installs a GLOBAL, site-wide cart bundle rule (see below):
 *  - Business rule: whenever ANY product with variant options matching
 *    the configured trigger (default Black / Medium) is added to the
 *    cart — from this popup, a normal product page (PDP), a quick-buy
 *    button, anywhere — the configured bundle product (default handle
 *    "soft-winter-jacket") is added automatically right after it.
 *
 * No external dependencies (no jQuery). One ShopTheLook instance per
 * section, so the section can be added to a page multiple times safely.
 * The global bundle rule is installed once per page, independent of how
 * many "Shop the look" sections exist (or even if none exist at all).
 * ---------------------------------------------------------------------------
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Dawn does not ship an arrow icon for buttons out of the box, so we
  // render our own next to "Add to cart" (matches the reference design).
  //
  // >>> REEMPLAZA la URL de abajo con la de tu imagen de flecha <<<
  // Súbela en el admin de Shopify en Configuración > Archivos, copia la
  // URL del archivo y pégala aquí.
  const ARROW_ICON_URL =
    "https://cdn.shopify.com/s/files/1/0000/0000/0000/files/arrow-right.png";
  // ---------------------------------------------------------------------

  // Simple in-memory cache so re-opening the same product doesn't re-fetch.
  const productCache = new Map();

  /**
   * Fetches a product by handle via the Storefront AJAX API, sharing the
   * same in-memory cache used by the quick-view modal. Used both by
   * ShopTheLook instances and by the global bundle rule below.
   */
  async function fetchProductByHandle(handle) {
    if (productCache.has(handle)) return productCache.get(handle);

    const response = await fetch(`/products/${handle}.js`);
    if (!response.ok) throw new Error(`Product "${handle}" not found`);

    const product = await response.json();
    productCache.set(handle, product);
    return product;
  }

  /**
   * Re-renders Dawn's cart drawer / cart icon bubble in place using the
   * Section Rendering API. Shared by ShopTheLook instances and the global
   * bundle rule, so the drawer reflects the auto-added bundle item too.
   */
  async function refreshCartUI() {
    try {
      const response = await fetch(
        `${(window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/"}?sections=cart-drawer,cart-icon-bubble`,
      );
      if (!response.ok) return;
      const data = await response.json();
      const parser = new DOMParser();

      if (data["cart-drawer"]) {
        const doc = parser.parseFromString(data["cart-drawer"], "text/html");
        const newDrawer = doc.querySelector("cart-drawer");
        const oldDrawer = document.querySelector("cart-drawer");
        if (newDrawer && oldDrawer) {
          oldDrawer.replaceWith(newDrawer);
        }
      }

      if (data["cart-icon-bubble"]) {
        const doc = parser.parseFromString(
          data["cart-icon-bubble"],
          "text/html",
        );
        const newBubble = doc.querySelector(".shopify-section");
        const oldBubble = document.getElementById("cart-icon-bubble");
        if (newBubble && oldBubble) oldBubble.innerHTML = newBubble.innerHTML;
      }

      const drawer = document.querySelector("cart-drawer");
      if (drawer && typeof drawer.open === "function") {
        drawer.open();
      }
    } catch (error) {
      // Non-fatal: the item is already in the cart even if the drawer
      // failed to refresh visually.
      console.warn("[cart-bundle-rule] Could not refresh cart drawer:", error);
    }
  }

  /* =========================================================================
   * GLOBAL CART BUNDLE RULE (site-wide)
   * -------------------------------------------------------------------------
   * Whenever ANY product variant whose options match the configured
   * trigger (default: Black / Medium) is added to the cart — from this
   * "Shop the look" popup, a normal product page, a collection quick-buy
   * button, another app, anywhere — the configured bundle product
   * (default handle "soft-winter-jacket") is added automatically too.
   *
   * HOW IT WORKS (important, read before touching this):
   *  1. We patch window.fetch exactly once. The patched fetch ALWAYS
   *     calls the real, original fetch FIRST and returns that exact
   *     promise to the caller, untouched. This is the #1 rule: our code
   *     must never delay, alter, or break a normal add-to-cart request.
   *  2. We only ever LOOK AT THE RESPONSE (via response.clone(), which
   *     never disturbs the original body stream) of requests going to
   *     Shopify's /cart/add.js endpoint. We never read or modify the
   *     request body — Dawn's product form posts a FormData body, and
   *     trying to inspect/clone that is unnecessary and risky, so we
   *     don't do it.
   *  3. Shopify's /cart/add.js response already includes
   *     `options_with_values` for every line item added — e.g.
   *     [{ name: "Color", value: "Black" }, { name: "Size", value: "Medium" }]
   *     — so we can check the trigger directly from the response, with
   *     no need to look anything up in a product cache.
   *  4. If triggered, we fire a second, independent POST to
   *     /cart/add.js (using the *original*, unpatched fetch, so it's
   *     never re-inspected) to add the bundle product, then refresh the
   *     cart drawer.
   *  5. Every step is wrapped in try/catch. Worst case if something
   *     goes wrong here: the bundle simply doesn't get added — the
   *     customer's own add-to-cart action is never affected.
   *
   * DEPLOYMENT NOTE: this rule only runs on pages where this script is
   * actually loaded. If shop-the-look.js is only included on pages that
   * render the "Shop the look" section, add-to-cart actions on pages
   * without that section (e.g. a plain product page) won't be covered.
   * To make the rule truly site-wide, include this script from
   * theme.liquid (or another snippet that loads on every page).
   * ========================================================================= */

  const CART_ADD_ENDPOINT_RE = /\/cart\/add(\.js)?(\?|$)/i;

  function getRequestUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url; // Request object
    return String(input || "");
  }

  function getRequestMethod(input, init) {
    if (init && init.method) return init.method;
    if (input && typeof input.method === "string") return input.method; // Request object
    return "GET";
  }

  /**
   * Reads the merchant-configured bundle trigger. Reuses the same
   * data-* attributes already exposed on the "Shop the look" section (so
   * merchants keep a single place to configure this in the customizer),
   * falling back to the documented defaults (Black / Medium /
   * soft-winter-jacket) when that section isn't present on the current
   * page at all.
   */
  function getBundleConfig() {
    const root = document.querySelector("[data-shop-the-look]");
    return {
      handle: (
        (root && root.dataset.bundleHandle) ||
        "soft-winter-jacket"
      ).trim(),
      color: ((root && root.dataset.bundleColor) || "black")
        .trim()
        .toLowerCase(),
      size: ((root && root.dataset.bundleSize) || "medium")
        .trim()
        .toLowerCase(),
    };
  }

  // Size aliases so "Medium", "M", "MEDIUM", etc. are all treated as the
  // same size. Covers the shop's XS / S / M / L range plus common full
  // words, so merchants can type either in the "bundle size" setting.
  const SIZE_ALIASES = {
    xs: "xs",
    "extra small": "xs",
    s: "s",
    small: "s",
    m: "m",
    med: "m",
    medium: "m",
    l: "l",
    large: "l",
    xl: "xl",
    "extra large": "xl",
  };

  function normalizeSize(value) {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    return SIZE_ALIASES[normalized] || normalized;
  }

  function normalizeColor(value) {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  /**
   * Checks whether a cart line item (as returned by /cart/add.js) matches
   * the configured bundle trigger, regardless of option order, case, or
   * whether the size was typed as "M" or "Medium".
   */
  function itemMatchesBundleTrigger(item, config) {
    if (!config.color && !config.size) return false;

    const optionValues = Array.isArray(item.options_with_values)
      ? item.options_with_values.map((option) => option.value)
      : [];

    const hasColor =
      !config.color ||
      optionValues.some(
        (value) => normalizeColor(value) === normalizeColor(config.color),
      );
    const hasSize =
      !config.size ||
      optionValues.some(
        (value) => normalizeSize(value) === normalizeSize(config.size),
      );

    return hasColor && hasSize;
  }

  async function getBundleVariantId(handle) {
    try {
      const bundleProduct = await fetchProductByHandle(handle);
      const availableVariant =
        bundleProduct.variants.find((v) => v.available) ||
        bundleProduct.variants[0];
      return availableVariant ? availableVariant.id : null;
    } catch (error) {
      console.warn(
        `[cart-bundle-rule] Could not load bundle product "${handle}":`,
        error,
      );
      return null;
    }
  }

  /**
   * Inspects the (cloned) response of a completed /cart/add(.js) request
   * and, if it matches the trigger, fires a second /cart/add.js request
   * to add the bundle product. Uses the *original*, unpatched fetch for
   * that second request so it's never re-inspected (no re-entrancy/loop).
   */
  async function handleCartAddResponse(response, originalFetch) {
    try {
      if (!response || !response.ok) return;

      let data;
      try {
        data = await response.json();
      } catch (error) {
        return; // Not a JSON response — nothing we can inspect.
      }

      // /cart/add.js returns either a single line item object, or
      // { items: [...] } when multiple items were posted at once.
      const items = Array.isArray(data.items)
        ? data.items
        : data.id
          ? [data]
          : [];
      if (items.length === 0) return;

      const config = getBundleConfig();
      if (!config.handle) return;

      // If the bundle product was already part of this same request (the
      // customer added it manually alongside the triggering product),
      // don't add a second one.
      const bundleAlreadyIncluded = items.some(
        (item) => item.handle === config.handle,
      );
      if (bundleAlreadyIncluded) return;

      const triggered = items.some((item) =>
        itemMatchesBundleTrigger(item, config),
      );
      if (!triggered) return;

      const bundleVariantId = await getBundleVariantId(config.handle);
      if (!bundleVariantId) return;

      const addResponse = await originalFetch("/cart/add.js", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          items: [{ id: bundleVariantId, quantity: 1 }],
        }),
      });

      if (addResponse.ok) {
        await refreshCartUI();
      } else {
        console.warn(
          "[cart-bundle-rule] Failed to add bundle product to cart.",
        );
      }
    } catch (error) {
      console.warn(
        "[cart-bundle-rule] Error processing cart add response:",
        error,
      );
    }
  }

  /**
   * Patches window.fetch exactly once so every /cart/add(.js) call made
   * anywhere on the page — by this file, Dawn's own product-form.js, a
   * quick-buy button, another app, etc. — is observed without ever
   * altering its behavior, timing, or body for the original caller.
   */
  function initGlobalCartBundleRule() {
    if (window.__cartBundleRuleInitialized) return;
    window.__cartBundleRuleInitialized = true;

    const originalFetch = window.fetch.bind(window);

    window.fetch = function (input, init) {
      // Rule #1: the real request always goes out first, completely
      // untouched, and this exact promise is what we return to the
      // caller. Nothing below this line can delay or break it.
      const responsePromise = originalFetch(input, init);

      try {
        const url = getRequestUrl(input);
        const method = getRequestMethod(input, init);
        const isCartAdd =
          CART_ADD_ENDPOINT_RE.test(url) &&
          String(method).toUpperCase() === "POST";

        if (isCartAdd) {
          responsePromise
            .then((response) => response.clone())
            .then((clone) => handleCartAddResponse(clone, originalFetch))
            .catch((error) => {
              console.warn("[cart-bundle-rule] Bundle check failed:", error);
            });
        }
      } catch (error) {
        // Even a bug in the detection setup above must never affect the
        // real add-to-cart request, which was already sent above.
        console.warn("[cart-bundle-rule] Could not inspect request:", error);
      }

      return responsePromise;
    };
  }

  class ShopTheLook {
    /**
     * @param {HTMLElement} root - the `.shop-the-look` section wrapper
     */
    constructor(root) {
      this.root = root;
      this.modal = root.querySelector("[data-modal]");
      this.modalContent = root.querySelector("[data-modal-content]");
      this.closeButton = root.querySelector("[data-modal-close]");

      // Config read from data-* attributes so it stays editable from the
      // theme customizer without touching this file.
      this.moneyFormat = root.dataset.moneyFormat || "${{amount}}";
      this.cartAddUrl = root.dataset.cartAddUrl || "/cart/add.js";
      this.cartUrl = root.dataset.cartUrl || "/cart";
      this.bundleHandle = (root.dataset.bundleHandle || "").trim();
      this.bundleColor = (root.dataset.bundleColor || "").trim().toLowerCase();
      this.bundleSize = (root.dataset.bundleSize || "").trim().toLowerCase();

      // State for the product currently shown in the modal.
      this.currentProduct = null;
      this.selectedOptions = [];

      this.bindEvents();
    }

    bindEvents() {
      // Event delegation: one listener handles every hotspot in this section.
      this.root.addEventListener("click", (event) => {
        const hotspot = event.target.closest("[data-hotspot]");
        if (hotspot) {
          this.openModal(hotspot.dataset.productHandle);
        }
      });

      this.closeButton.addEventListener("click", () => this.closeModal());

      // Click on the backdrop (the dialog element itself, outside the
      // inner content box) closes the modal.
      this.modal.addEventListener("click", (event) => {
        if (event.target === this.modal) this.closeModal();
      });

      // <dialog> already closes on Escape natively; make sure our state
      // resets when it does (e.g. Escape key, or programmatic close()).
      this.modal.addEventListener("close", () => this.resetModalState());
    }

    /* ----------------------------- Modal open/close ----------------------------- */

    async openModal(handle) {
      if (!handle) return;

      this.renderLoading();
      this.modal.showModal();

      try {
        const product = await this.getProduct(handle);
        this.currentProduct = product;

        // No pre-seleccionamos ningún valor: el cliente debe elegir color y
        // talla explícitamente (así "Choose your size" se muestra siempre
        // al abrir, y "Add to cart" empieza deshabilitado).
        const sortedOptions = this.sortOptions(product.options);
        this.selectedOptions = sortedOptions.map(() => null);

        this.renderProduct(product);
      } catch (error) {
        console.error("[shop-the-look] Failed to load product:", error);
        this.renderError();
      }
    }

    closeModal() {
      this.modal.close();
    }

    resetModalState() {
      this.currentProduct = null;
      this.selectedOptions = [];
      this.modalContent.innerHTML = "";
    }

    /* ----------------------------- Data fetching ----------------------------- */

    async getProduct(handle) {
      return fetchProductByHandle(handle);
    }

    /* ----------------------------- Rendering ----------------------------- */

    renderLoading() {
      this.modalContent.innerHTML = `
        <div class="stl-quickview__loading">
          <div class="stl-spinner" aria-hidden="true"></div>
          <p>Loading…</p>
        </div>
      `;
    }

    renderError() {
      this.modalContent.innerHTML = `
        <div class="stl-quickview__error">
          <p>Sorry, this product could not be loaded. Please try again.</p>
        </div>
      `;
    }

    renderProduct(product) {
      // "display" variant: used only to show a price/image while the
      // customer is still choosing options (falls back to the first
      // available variant). It is NOT considered a real selection.
      const displayVariant = this.getDisplayVariant(product);
      // Strict match: null until every option has been explicitly picked.
      // This is what actually controls the Add to cart button.
      const matchedVariant = this.getMatchingVariant(product);

      const image =
        (displayVariant &&
          displayVariant.featured_image &&
          displayVariant.featured_image.src) ||
        product.featured_image;

      // Reordenar opciones: Color primero, luego Size, luego las demás
      const sortedOptions = this.sortOptions(product.options);
      const addToCartDisabled = !matchedVariant || !matchedVariant.available;

      this.modalContent.innerHTML = `
        <div class="stl-quickview">
          <div class="stl-quickview__top">
            ${
              image
                ? `<img class="stl-quickview__image" src="${this.resizeImage(image, 200)}" alt="${this.escapeHtml(product.title)}">`
                : ""
            }
            <div>
              <h2 class="stl-quickview__title">${this.escapeHtml(product.title)}</h2>
              <p class="stl-quickview__price" data-price>${this.renderPrice(displayVariant)}</p>
               ${
                 product.description
                   ? `<div class="stl-quickview__description">${product.description}</div>`
                   : ""
               }
            </div>
          </div>         

          <div data-options>
            ${sortedOptions.map((option, index) => this.renderOption(product, option, index)).join("")}
          </div>

          <button
            type="button"
            class="stl-quickview__add-to-cart"
            data-add-to-cart
            ${addToCartDisabled ? "disabled" : ""}
          >
            <span class="stl-quickview__add-to-cart-label">${this.addToCartLabel(matchedVariant)}</span>
            <img class="stl-quickview__add-to-cart-arrow" src="https://cdn.shopify.com/s/files/1/0997/7931/3953/files/arrow.webp?v=1787444485" alt="" width="33" height="8">
          </button>

          <p class="stl-quickview__message" data-message role="status" aria-live="polite"></p>
        </div>
      `;

      this.bindOptionEvents(product);
      this.bindAddToCart(product);
    }

    /**
     * Reordena las opciones para que Color vaya primero, luego Size, y el resto
     * mantiene su orden original.
     */
    sortOptions(options) {
      if (!options || options.length === 0) return options;

      const colorIndex = options.findIndex((opt) =>
        /colou?r/i.test(opt.name || ""),
      );
      const sizeIndex = options.findIndex((opt) =>
        /size/i.test(opt.name || ""),
      );

      // Si no hay color o size, devolver el array original
      if (colorIndex === -1 && sizeIndex === -1) return [...options];

      // Crear una copia del array para no modificar el original
      const sorted = [...options];

      // Si hay color, moverlo al principio
      if (colorIndex !== -1) {
        const [color] = sorted.splice(colorIndex, 1);
        sorted.unshift(color);
      }

      // Si hay size, moverlo a la segunda posición (después de color)
      if (sizeIndex !== -1) {
        // Recalcular el índice del size después de posiblemente mover el color
        const currentSizeIndex = sorted.findIndex((opt) =>
          /size/i.test(opt.name || ""),
        );
        if (currentSizeIndex !== -1) {
          const [size] = sorted.splice(currentSizeIndex, 1);
          // Insertar después de color (posición 1) o al principio si no hay color
          const insertPosition = colorIndex !== -1 ? 1 : 0;
          sorted.splice(insertPosition, 0, size);
        }
      }

      return sorted;
    }

    /**
     * Renders one option group. Options whose name looks like a color get
     * swatch-style buttons (matches the reference screenshot); every other
     * option (size, material, etc.) gets a native <select> for the most
     * robust, accessible default.
     */
    renderOption(product, option, optionIndex) {
      const optionName = option.name || "";
      const values = this.getOptionValues(product, optionIndex);
      const isColor = /colou?r/i.test(optionName);
      const isSize = /size/i.test(optionName);
      const selectedValue = this.selectedOptions[optionIndex];

      if (isColor) {
        const swatches = values
          .map((value) => {
            const available = this.isOptionValueAvailable(
              product,
              optionIndex,
              value,
            );
            const pressed = value === selectedValue;
            return `
              <button
                type="button"
                class="stl-swatch"
                data-option-index="${optionIndex}"
                data-option-value="${this.escapeHtml(value)}"
                aria-pressed="${pressed}"
                style="--stl-swatch-color: ${this.escapeHtml(value)};"
                ${available ? "" : "disabled"}
              >
                <span class="stl-swatch__label">${this.escapeHtml(value)}</span>
              </button>
            `;
          })
          .join("");

        return `
          <div class="stl-quickview__option">
            <span class="stl-quickview__option-label">${this.escapeHtml(optionName)}</span>
            <div class="stl-quickview__swatches">${swatches}</div>
          </div>
        `;
      }

      // Placeholder text: "Choose your size" for the size option,
      // "Choose {option}" for any other select-style option.
      const placeholderLabel = isSize
        ? "Choose your size"
        : `Choose ${optionName}`;

      const options = values
        .map((value) => {
          const available = this.isOptionValueAvailable(
            product,
            optionIndex,
            value,
          );
          const selected = value === selectedValue ? "selected" : "";
          return `<option value="${this.escapeHtml(value)}" ${selected} ${available ? "" : "disabled"}>
            ${this.escapeHtml(value)}${available ? "" : " (sold out)"}
          </option>`;
        })
        .join("");

      return `
        <div class="stl-quickview__option">
          <label class="stl-quickview__option-label" for="stl-option-${optionIndex}">${this.escapeHtml(optionName)}</label>
          <div class="stl-quickview__select-wrapper">
            <select class="stl-quickview__select" id="stl-option-${optionIndex}" data-option-index="${optionIndex}">
              <option value="" disabled hidden ${selectedValue ? "" : "selected"}>${this.escapeHtml(placeholderLabel)}</option>
              ${options}
            </select>
          </div>
        </div>
      `;
    }

    bindOptionEvents(product) {
      // Color swatches
      this.modalContent.querySelectorAll(".stl-swatch").forEach((button) => {
        button.addEventListener("click", () => {
          const index = Number(button.dataset.optionIndex);
          this.selectedOptions[index] = button.dataset.optionValue;
          this.onOptionsChanged(product);
        });
      });

      // Native selects (size, etc.)
      this.modalContent
        .querySelectorAll(".stl-quickview__select")
        .forEach((select) => {
          select.addEventListener("change", () => {
            const index = Number(select.dataset.optionIndex);
            this.selectedOptions[index] = select.value;
            this.onOptionsChanged(product);
          });
        });
    }

    /**
     * Re-renders the parts of the UI that depend on the selected variant
     * (price, swatch pressed-state, availability, add-to-cart state)
     * without rebuilding the whole option UI — keeps focus/scroll stable.
     */
    onOptionsChanged(product) {
      // Strict match (all options explicitly selected) — controls the button.
      const matchedVariant = this.getMatchingVariant(product);
      // Fallback used only for price/image while selection is incomplete.
      const displayVariant = this.getDisplayVariant(product);

      // Update price
      const priceEl = this.modalContent.querySelector("[data-price]");
      if (priceEl) priceEl.innerHTML = this.renderPrice(displayVariant);

      // Update pressed state on color swatches
      this.modalContent.querySelectorAll(".stl-swatch").forEach((button) => {
        const index = Number(button.dataset.optionIndex);
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.optionValue === this.selectedOptions[index]),
        );
      });

      // Update disabled options across every option group given the new
      // combination (classic "which combinations remain possible" logic
      // is intentionally kept simple here: we just disable option values
      // that have no available variant at all).
      this.modalContent
        .querySelectorAll("[data-option-index]")
        .forEach((el) => {
          const index = Number(el.dataset.optionIndex);
          if (el.classList.contains("stl-swatch")) {
            el.disabled = !this.isOptionValueAvailable(
              product,
              index,
              el.dataset.optionValue,
            );
          }
        });

      // Update add-to-cart button state/label. Disabled until every
      // option has been explicitly chosen and the resulting variant
      // is in stock.
      const addButton = this.modalContent.querySelector("[data-add-to-cart]");
      if (addButton) {
        addButton.disabled = !matchedVariant || !matchedVariant.available;
        const labelEl = addButton.querySelector(
          ".stl-quickview__add-to-cart-label",
        );
        const label = this.addToCartLabel(matchedVariant);
        if (labelEl) {
          labelEl.textContent = label;
        } else {
          addButton.textContent = label;
        }
      }

      // Clear any previous status message once the selection changes.
      const message = this.modalContent.querySelector("[data-message]");
      if (message) {
        message.textContent = "";
        message.removeAttribute("data-state");
      }
    }

    addToCartLabel(variant) {
      // No variant yet just means the customer hasn't finished picking
      // options — keep the label as "Add to cart" (disabled), only switch
      // to "Sold out" when a specific combination truly is unavailable.
      if (!variant) return "Add to cart";
      return variant.available ? "Add to cart" : "Sold out";
    }

    /* ----------------------------- Variant helpers ----------------------------- */

    getOptionValues(product, optionIndex) {
      // El optionIndex ahora corresponde al índice en el array ordenado
      // Necesitamos encontrar el índice original en product.options
      const sortedOptions = this.sortOptions(product.options);
      const originalOption = sortedOptions[optionIndex];
      const originalIndex = product.options.indexOf(originalOption);

      const values = product.variants.map(
        (variant) => variant.options[originalIndex],
      );
      return [...new Set(values)];
    }

    isOptionValueAvailable(product, optionIndex, value) {
      const sortedOptions = this.sortOptions(product.options);
      const originalOption = sortedOptions[optionIndex];
      const originalIndex = product.options.indexOf(originalOption);

      return product.variants.some(
        (variant) =>
          variant.options[originalIndex] === value && variant.available,
      );
    }

    /**
     * Strict match: returns a variant only when every option has been
     * explicitly selected by the customer. Returns undefined otherwise,
     * which keeps "Add to cart" disabled (business requirement).
     */
    getMatchingVariant(product) {
      const sortedOptions = this.sortOptions(product.options);

      // If any option is still unselected (null), there is no real match.
      const allSelected = sortedOptions.every(
        (_, index) => this.selectedOptions[index] != null,
      );
      if (!allSelected) return undefined;

      return product.variants.find((variant) => {
        return sortedOptions.every((option, index) => {
          const originalIndex = product.options.indexOf(option);
          return variant.options[originalIndex] === this.selectedOptions[index];
        });
      });
    }

    /**
     * Non-strict variant used only to show a price/image before the
     * customer finishes selecting options: the real match if we have one,
     * otherwise the first available variant (falling back to the very
     * first variant if none are in stock).
     */
    getDisplayVariant(product) {
      return (
        this.getMatchingVariant(product) ||
        product.variants.find((v) => v.available) ||
        product.variants[0]
      );
    }

    /* ----------------------------- Cart ----------------------------- */

    bindAddToCart(product) {
      const button = this.modalContent.querySelector("[data-add-to-cart]");
      const message = this.modalContent.querySelector("[data-message]");
      if (!button) return;

      button.addEventListener("click", async () => {
        const variant = this.getMatchingVariant(product);
        if (!variant || !variant.available) return;

        button.disabled = true;
        const originalLabel = button.textContent;
        button.textContent = "Adding…";
        message.textContent = "";
        message.removeAttribute("data-state");

        try {
          const items = [{ id: variant.id, quantity: 1 }];

          // --- Business rule -------------------------------------------------
          // If this variant matches the configured bundle trigger (default:
          // Black + Medium), add the configured bundle product too. Note:
          // the global bundle rule above would also catch this same add
          // from its own response-inspection, but resolving it here too
          // means the bundle line lands in the SAME /cart/add.js request
          // (nicer UX: one network round trip, one "Added!" message).
          // itemMatchesBundleTrigger() on the global rule still guards
          // against double-adding if this path already included it.
          let bundleAdded = false;
          if (this.variantMatchesBundleTrigger(variant) && this.bundleHandle) {
            const bundleVariantId = await this.getBundleVariantId();
            if (bundleVariantId) {
              items.push({ id: bundleVariantId, quantity: 1 });
              bundleAdded = true;
            }
          }
          // ---------------------------------------------------------------------

          await this.addItemsToCart(items);

          button.textContent = "Added!";
          message.dataset.state = "success";
          message.textContent = bundleAdded
            ? "Added to your cart, along with the Soft Winter Jacket."
            : "Added to your cart.";

          await this.refreshCartDrawer();

          setTimeout(() => {
            button.textContent = originalLabel;
            button.disabled = false;
          }, 1500);
        } catch (error) {
          console.error("[shop-the-look] Add to cart failed:", error);
          message.dataset.state = "error";
          message.textContent =
            error.message || "Could not add this item to your cart.";
          button.textContent = originalLabel;
          button.disabled = false;
        }
      });
    }

    /**
     * Checks whether a variant's option values include both the
     * merchant-configured bundle trigger color and size, regardless of
     * option order, letter case, or whether the size is typed as "M" or
     * "Medium".
     */
    variantMatchesBundleTrigger(variant) {
      if (!this.bundleColor && !this.bundleSize) return false;
      const values = variant.options.map((value) => String(value));

      const hasColor =
        !this.bundleColor ||
        values.some(
          (value) => normalizeColor(value) === normalizeColor(this.bundleColor),
        );
      const hasSize =
        !this.bundleSize ||
        values.some(
          (value) => normalizeSize(value) === normalizeSize(this.bundleSize),
        );

      return hasColor && hasSize;
    }

    async getBundleVariantId() {
      try {
        const bundleProduct = await this.getProduct(this.bundleHandle);
        const availableVariant =
          bundleProduct.variants.find((v) => v.available) ||
          bundleProduct.variants[0];
        return availableVariant ? availableVariant.id : null;
      } catch (error) {
        console.error(
          `[shop-the-look] Could not load bundle product "${this.bundleHandle}":`,
          error,
        );
        return null;
      }
    }

    async addItemsToCart(items) {
      const response = await fetch(this.cartAddUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ items }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data.description || data.message || "Add to cart failed",
        );
      }
      return data;
    }

    /**
     * Re-renders Dawn's cart drawer / cart icon bubble in place using the
     * Section Rendering API, then opens the drawer if present. Falls back
     * gracefully to just linking to the cart if the theme doesn't use
     * Dawn's default cart drawer.
     */
    async refreshCartDrawer() {
      return refreshCartUI();
    }

    /* ----------------------------- Utilities ----------------------------- */

    /** Formats a price in cents using the shop's money_format Liquid string. */
    renderPrice(variant) {
      if (!variant) return "";
      const price = this.formatMoney(variant.price);
      if (
        variant.compare_at_price &&
        variant.compare_at_price > variant.price
      ) {
        const compareAt = this.formatMoney(variant.compare_at_price);
        return `<span class="stl-quickview__price--compare">${compareAt}</span>${price}`;
      }
      return price;
    }

    /**
     * Minimal re-implementation of Shopify.formatMoney, supporting the
     * common money_format tokens so the popup respects the shop's
     * currency formatting without relying on theme globals being present.
     */
    formatMoney(cents) {
      const amount = (cents / 100).toFixed(2);
      const [whole, decimal] = amount.split(".");
      const withThousands = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

      let format = this.moneyFormat;
      format = format.replace(/{{\s*amount_no_decimals\s*}}/g, withThousands);
      format = format.replace(
        /{{\s*amount\s*}}/g,
        `${withThousands}.${decimal}`,
      );
      format = format.replace(
        /{{\s*amount_with_comma_separator\s*}}/g,
        `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${decimal}`,
      );

      // Fallback if the format string had no recognized token at all.
      if (
        format === this.moneyFormat &&
        !/{{\s*amount/.test(this.moneyFormat)
      ) {
        format = `$${withThousands}.${decimal}`;
      }
      return format;
    }

    resizeImage(url, width) {
      if (!url) return url;
      return url.includes("?")
        ? `${url}&width=${width}`
        : `${url}?width=${width}`;
    }

    escapeHtml(value) {
      const div = document.createElement("div");
      div.textContent = value == null ? "" : String(value);
      return div.innerHTML;
    }
  }

  /* ----------------------------- Init ----------------------------- */

  function initShopTheLook() {
    document.querySelectorAll("[data-shop-the-look]").forEach((root) => {
      if (!root.dataset.stlInitialized) {
        new ShopTheLook(root);
        root.dataset.stlInitialized = "true";
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initShopTheLook);
  } else {
    initShopTheLook();
  }

  // Re-init if the section is added/re-rendered live in the theme editor.
  document.addEventListener("shopify:section:load", initShopTheLook);

  // The bundle rule itself has no dependency on the "Shop the look"
  // section's DOM — it only patches fetch — so it's activated
  // immediately, independent of initShopTheLook/DOMContentLoaded.
  initGlobalCartBundleRule();
})();
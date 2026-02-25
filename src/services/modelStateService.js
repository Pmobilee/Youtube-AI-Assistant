async function buildModelState(deps, { force = false } = {}) {
  const {
    ensureSelectedTextModel,
    selectedTextProvider,
    getSelectedEditor,
    providerStatus,
    imageModelCandidates,
    imageGenerationModel,
    imageAnalysisProviderOptions,
    selectedImageAnalysisProvider,
    selectedImageAnalysisModel,
    imageGenerationProviderOptions,
    selectedImageGenerationProvider,
    selectedImageGenerationModel,
    getImageAnalysisModels,
    getImageGenerationModels,
    listEditors,
    getEditorContextMeta,
  } = deps;

  const ensured = await ensureSelectedTextModel({
    provider: selectedTextProvider,
    force,
    activateProvider: true,
  });

  const editor = getSelectedEditor();

  return {
    textProvider: ensured.provider,
    selectedTextProvider: ensured.provider,
    selectedModel: ensured.selectedModel,
    models: ensured.models,
    textProviders: providerStatus(),

    imageProvider: selectedImageGenerationProvider,
    imageModels: imageModelCandidates,
    imageGenerationModel,

    imageAnalysisProviders: imageAnalysisProviderOptions,
    selectedImageAnalysisProvider,
    selectedImageAnalysisModel,
    imageAnalysisModels: getImageAnalysisModels(selectedImageAnalysisProvider),

    imageGenerationProviders: imageGenerationProviderOptions,
    selectedImageGenerationProvider,
    selectedImageGenerationModel,
    imageGenerationModels: getImageGenerationModels(selectedImageGenerationProvider),

    selectedEditorId: editor.id,
    selectedEditorName: editor.name,
    selectedEditorShortName: editor.shortName,
    editors: listEditors(),
    editorContext: getEditorContextMeta(editor.id),
  };
}

module.exports = {
  buildModelState,
};

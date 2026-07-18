import { WorkerStatus, WorkerType } from "@/core/enums";
import { SettingModel, WorkerModel } from "@/db/models";

export const getSetting = async (name: string) => {
    try {
        
        const setting = await SettingModel.findOne({ name }).lean();
        if (!setting) return null;

        return setting.value;

    } catch (error) {
        return null
    }
};

export const getSettingsByNames = async (names: string[]) => {
    try {
        
        const settings = await SettingModel.find({
            name: { $in: names }
        }).lean();

        // แปลงเป็น object
        const settingsObject = settings.reduce((acc, setting) => {
            acc[setting.name] = setting.value;
            return acc;
        }, {} as Record<string, any>);

        return settingsObject;
    } catch (error) {
        return {}
    }
};


export const getSettings = async () => {
    try {
        
        const results = await SettingModel.find({}).lean();

        const settings = results.reduce((acc, setting) => {
            acc[setting.name] = setting.value;
            return acc;
        }, {} as Record<string, any>);

        return settings;
    } catch (error) {
        return {}
    }
};